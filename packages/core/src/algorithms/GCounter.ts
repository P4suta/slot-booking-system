/**
 * Grow-only counter (G-Counter) — Shapiro et al. (2011) state-based
 * CRDT (ADR-0081). Each replica owns one slot in a `(siteId →
 * count)` map; the observed value is the sum across slots. Local
 * increments touch only the owner's slot; merging is the elementwise
 * maximum. Total count is monotonic by construction (no
 * decrements).
 *
 * Powers the v6 `ShopState.laneCounts`: walk-in / priority /
 * reservation cardinality is a sum of per-replica observations,
 * accumulating across DO migrations / replays.
 *
 * Laws (pinned by property test):
 *   - associativity: merge(merge(a, b), c) = merge(a, merge(b, c))
 *   - commutativity: merge(a, b) = merge(b, a)
 *   - idempotency:   merge(a, a) = a
 *   - monotonicity:  value(merge(a, b)) ≥ max(value(a), value(b))
 */
export type SiteId = string

export type GCounter = {
  readonly slots: ReadonlyMap<SiteId, number>
}

export const GCounter = {
  empty: (): GCounter => ({ slots: new Map<SiteId, number>() }),

  /** Total observed count across every slot. */
  value: (counter: GCounter): number => {
    let sum = 0
    for (const v of counter.slots.values()) sum += v
    return sum
  },

  /** Increment `site`'s slot by `n` (default 1). `n` must be non-negative. */
  increment: (counter: GCounter, site: SiteId, n = 1): GCounter => {
    if (n < 0 || !Number.isInteger(n)) {
      throw new RangeError(`GCounter increment must be a non-negative integer, got ${String(n)}`)
    }
    const next = new Map(counter.slots)
    next.set(site, (next.get(site) ?? 0) + n)
    return { slots: next }
  },

  /** Elementwise maximum — the CRDT join. */
  merge: (a: GCounter, b: GCounter): GCounter => {
    const next = new Map<SiteId, number>(a.slots)
    for (const [site, count] of b.slots) {
      const prev = next.get(site) ?? 0
      next.set(site, Math.max(prev, count))
    }
    return { slots: next }
  },

  equals: (a: GCounter, b: GCounter): boolean => {
    if (a.slots.size !== b.slots.size) return false
    for (const [site, count] of a.slots) {
      if (b.slots.get(site) !== count) return false
    }
    return true
  },
} as const
