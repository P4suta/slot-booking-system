/**
 * Vector clock — Lamport (1978) / Fidge & Mattern (1988) (ADR-0081
 * part 1). Each replica owns one slot in a `(siteId → counter)`
 * map; advancing time increments the owner's counter; merging two
 * clocks takes the elementwise maximum.
 *
 * `VectorClock` carries the happens-before partial order:
 *
 *   `a ≤ b`  iff  ∀ s. a[s] ≤ b[s]
 *   `a < b`  iff  a ≤ b ∧ a ≠ b
 *   `a ∥ b` (concurrent) iff  ¬(a ≤ b) ∧ ¬(b ≤ a)
 *
 * The slot-booking wire envelope (v6, ADR-0081 part 2) uses the
 * clock to detect snapshot/delta gaps: a client whose `since`
 * vector is incomparable with the server's must resync.
 *
 * Implementation is structural (readonly record with a deep-clone
 * `tick` / `merge` discipline) so values are safely shared across
 * delta envelopes without aliasing.
 */
import type { SiteId } from "./GCounter.js"

export type VectorClock = {
  readonly counters: ReadonlyMap<SiteId, number>
}

export const VectorClock = {
  empty: (): VectorClock => ({ counters: new Map<SiteId, number>() }),

  of: (counters: Readonly<Record<SiteId, number>>): VectorClock => ({
    counters: new Map(Object.entries(counters)),
  }),

  get: (clock: VectorClock, site: SiteId): number => clock.counters.get(site) ?? 0,

  /** Advance `site`'s counter by 1. Pure — returns a new clock. */
  tick: (clock: VectorClock, site: SiteId): VectorClock => {
    const next = new Map(clock.counters)
    next.set(site, (next.get(site) ?? 0) + 1)
    return { counters: next }
  },

  /**
   * Elementwise max. Idempotent, commutative, associative — the
   * three CRDT lattice laws (pinned by property test).
   */
  merge: (a: VectorClock, b: VectorClock): VectorClock => {
    const next = new Map<SiteId, number>(a.counters)
    for (const [site, count] of b.counters) {
      const prev = next.get(site) ?? 0
      next.set(site, Math.max(prev, count))
    }
    return { counters: next }
  },

  /** `a ≤ b`: every site's a-counter is ≤ b-counter. */
  leq: (a: VectorClock, b: VectorClock): boolean => {
    for (const [site, count] of a.counters) {
      if ((b.counters.get(site) ?? 0) < count) return false
    }
    return true
  },

  /** Strict happens-before: `a ≤ b ∧ a ≠ b`. */
  happensBefore: (a: VectorClock, b: VectorClock): boolean =>
    VectorClock.leq(a, b) && !VectorClock.equals(a, b),

  /** Concurrent — incomparable under the happens-before partial order. */
  concurrent: (a: VectorClock, b: VectorClock): boolean =>
    !VectorClock.leq(a, b) && !VectorClock.leq(b, a),

  equals: (a: VectorClock, b: VectorClock): boolean => {
    if (a.counters.size !== b.counters.size) return false
    for (const [site, count] of a.counters) {
      if (b.counters.get(site) !== count) return false
    }
    return true
  },
} as const
