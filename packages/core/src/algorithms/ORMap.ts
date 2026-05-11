/**
 * Observed-Remove Map (OR-Map) — key/value CRDT with last-writer-
 * wins semantics on the value side and OR-Set semantics on the key
 * side (ADR-0081). Each insert mints a unique tag; deletes collect
 * currently-observed tags into a tombstone set; concurrent
 * insert+delete on the same key resolves to insert (the fresh tag
 * survives the tombstone).
 *
 * The value carried per tag is the full payload at insert time, so
 * a concurrent "update Ticket on replica A" + "update on replica B"
 * keeps both tags; the materialised view picks the one with the
 * highest `version` (caller-supplied per-value monotone clock).
 *
 * Powers the v6 `ShopState.tickets`: a TicketId → ProjectionEntry
 * map that converges across DO replicas without flapping.
 *
 * Laws (pinned by property test):
 *   - associativity / commutativity / idempotency of merge
 *   - convergence under arbitrary operation interleaving.
 */
export type Tag = string

export type ORMapEntry<V> = {
  readonly tag: Tag
  readonly value: V
}

export type ORMap<K, V> = {
  readonly entries: ReadonlyMap<K, readonly ORMapEntry<V>[]>
  readonly tombstones: ReadonlySet<Tag>
}

/**
 * Resolver picks one of the surviving entries for a key. Default
 * resolver uses tag's natural string order — callers can pass a
 * value-aware resolver (e.g. monotone `version` field) for LWW
 * semantics tailored to the payload.
 *
 * The non-empty tuple shape encodes the precondition: a resolver is
 * only ever invoked when at least one live entry survives the
 * tombstone sweep.
 */
export type Resolver<V> = (entries: readonly [ORMapEntry<V>, ...ORMapEntry<V>[]]) => ORMapEntry<V>

export const ORMap = {
  empty: <K, V>(): ORMap<K, V> => ({
    entries: new Map<K, readonly ORMapEntry<V>[]>(),
    tombstones: new Set<Tag>(),
  }),

  /** All keys whose untombstoned entry set is non-empty. */
  keys: <K, V>(map: ORMap<K, V>): readonly K[] => {
    const out: K[] = []
    for (const [key, entries] of map.entries) {
      if (entries.some((e) => !map.tombstones.has(e.tag))) out.push(key)
    }
    return out
  },

  /** Look up a key, resolving among surviving entries. */
  get: <K, V>(map: ORMap<K, V>, key: K, resolve: Resolver<V> = defaultResolver): V | undefined => {
    const entries = map.entries.get(key)
    if (entries === undefined) return undefined
    const live = entries.filter((e) => !map.tombstones.has(e.tag))
    const [head, ...rest] = live
    if (head === undefined) return undefined
    return resolve([head, ...rest]).value
  },

  /** Mint `(tag, value)` and bind to key. */
  set: <K, V>(map: ORMap<K, V>, key: K, tag: Tag, value: V): ORMap<K, V> => {
    const prior = map.entries.get(key) ?? []
    const next = new Map(map.entries)
    next.set(key, [...prior, { tag, value }])
    return { entries: next, tombstones: map.tombstones }
  },

  /** Tombstone every currently-observed tag for `key`. */
  remove: <K, V>(map: ORMap<K, V>, key: K): ORMap<K, V> => {
    const entries = map.entries.get(key)
    if (entries === undefined) return map
    const tombstones = new Set(map.tombstones)
    for (const e of entries) tombstones.add(e.tag)
    return { entries: map.entries, tombstones }
  },

  /** Entry-set union per key + tombstone union — the CRDT join. */
  merge: <K, V>(a: ORMap<K, V>, b: ORMap<K, V>): ORMap<K, V> => {
    const entries = new Map<K, ORMapEntry<V>[]>()
    for (const [key, es] of a.entries) entries.set(key, [...es])
    for (const [key, es] of b.entries) {
      const prev = entries.get(key)
      if (prev === undefined) entries.set(key, [...es])
      else {
        const seen = new Set(prev.map((e) => e.tag))
        for (const e of es) if (!seen.has(e.tag)) prev.push(e)
      }
    }
    const tombstones = new Set<Tag>(a.tombstones)
    for (const tag of b.tombstones) tombstones.add(tag)
    return { entries, tombstones }
  },

  equals: <K, V>(a: ORMap<K, V>, b: ORMap<K, V>, equalsV: (x: V, y: V) => boolean): boolean => {
    if (a.entries.size !== b.entries.size) return false
    if (a.tombstones.size !== b.tombstones.size) return false
    for (const [key, ae] of a.entries) {
      const be = b.entries.get(key)
      if (be?.length !== ae.length) return false
      const aByTag = new Map(ae.map((e) => [e.tag, e.value] as const))
      for (const e of be) {
        const av = aByTag.get(e.tag)
        if (av === undefined || !equalsV(av, e.value)) return false
      }
    }
    for (const tag of a.tombstones) {
      if (!b.tombstones.has(tag)) return false
    }
    return true
  },
} as const

const defaultResolver = <V>(
  entries: readonly [ORMapEntry<V>, ...ORMapEntry<V>[]],
): ORMapEntry<V> => {
  const [head, ...rest] = entries
  let best = head
  for (const e of rest) {
    if (e.tag > best.tag) best = e
  }
  return best
}
