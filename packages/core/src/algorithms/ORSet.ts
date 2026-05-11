/**
 * Observed-Remove Set (OR-Set) — Shapiro et al. (2011) state-based
 * CRDT (ADR-0081). Add wins over concurrent remove via per-add
 * unique tags: each `add(x)` mints a fresh tag and records `(x,
 * tag)`; `remove(x)` collects the currently-observed tags into a
 * tombstone set; an element is present iff its tag set has an
 * untombstoned member.
 *
 * The v6 `ShopState.callableNow` is an OR-Set of `TicketId`. A
 * concurrent "add EDF entry on DO replica A" + "remove on replica
 * B because the customer cancelled" converge to **add** wins —
 * matching the staff Kanban's UX expectation that a fresh callable
 * doesn't get clobbered by a stale cancel.
 *
 * Laws (pinned by property test):
 *   - associativity / commutativity / idempotency of merge
 *   - convergence: replicas applying the same set of operations
 *     in arbitrary order observe the same membership.
 */
import type { Tag } from "./ORMap.js"

export type ORSet<T> = {
  readonly elements: ReadonlyMap<T, ReadonlySet<Tag>>
  readonly tombstones: ReadonlySet<Tag>
}

export const ORSet = {
  empty: <T>(): ORSet<T> => ({
    elements: new Map<T, ReadonlySet<Tag>>(),
    tombstones: new Set<Tag>(),
  }),

  /** Membership: a single non-tombstoned tag witnesses presence. */
  has: <T>(set: ORSet<T>, value: T): boolean => {
    const tags = set.elements.get(value)
    if (tags === undefined) return false
    for (const tag of tags) {
      if (!set.tombstones.has(tag)) return true
    }
    return false
  },

  /** Materialised value set, with tombstones honoured. */
  values: <T>(set: ORSet<T>): readonly T[] => {
    const out: T[] = []
    for (const [value, tags] of set.elements) {
      for (const tag of tags) {
        if (!set.tombstones.has(tag)) {
          out.push(value)
          break
        }
      }
    }
    return out
  },

  /** Add `value` with a freshly minted tag. */
  add: <T>(set: ORSet<T>, value: T, tag: Tag): ORSet<T> => {
    const tags = new Set(set.elements.get(value) ?? [])
    tags.add(tag)
    const elements = new Map(set.elements)
    elements.set(value, tags)
    return { elements, tombstones: set.tombstones }
  },

  /**
   * Remove every currently-observed tag for `value`. Concurrent
   * adds with *fresh* tags survive — that's the OR-Set's
   * "add wins" semantics.
   */
  remove: <T>(set: ORSet<T>, value: T): ORSet<T> => {
    const tags = set.elements.get(value)
    if (tags === undefined) return set
    const tombstones = new Set(set.tombstones)
    for (const tag of tags) tombstones.add(tag)
    return { elements: set.elements, tombstones }
  },

  /** Set-theoretic join: tag-set union per element + tombstone union. */
  merge: <T>(a: ORSet<T>, b: ORSet<T>): ORSet<T> => {
    const elements = new Map<T, Set<Tag>>()
    for (const [value, tags] of a.elements) elements.set(value, new Set(tags))
    for (const [value, tags] of b.elements) {
      const prev = elements.get(value)
      if (prev === undefined) elements.set(value, new Set(tags))
      else for (const tag of tags) prev.add(tag)
    }
    const tombstones = new Set<Tag>(a.tombstones)
    for (const tag of b.tombstones) tombstones.add(tag)
    return { elements, tombstones }
  },

  equals: <T>(a: ORSet<T>, b: ORSet<T>): boolean => {
    if (a.elements.size !== b.elements.size) return false
    if (a.tombstones.size !== b.tombstones.size) return false
    for (const [value, tags] of a.elements) {
      const bTags = b.elements.get(value)
      if (bTags?.size !== tags.size) return false
      for (const tag of tags) {
        if (!bTags.has(tag)) return false
      }
    }
    for (const tag of a.tombstones) {
      if (!b.tombstones.has(tag)) return false
    }
    return true
  },
} as const
