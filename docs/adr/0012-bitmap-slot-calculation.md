# 0012. Slot calculation via bitmap × bitwise AND

- Status: superseded by [ADR-0050](./0050-queue-pivot.md) — the slot bitmap algorithm is unused; the queue domain has no time-window matching.
- Superseded-By: ADR-0050
- Date: 2026-05-05
- Deciders: Yasunobu
- Tags: algorithm, performance

## Context

`computeAvailableSlots` is the hottest pure function in the system: it runs on every customer page load. SYSTEM.md §4.5.4 specifies its signature, including a `now` parameter for deterministic testing. The naïve "for each candidate slot, scan every booking, every absence, every closure" is O(slots × bookings × providers × resources) — measurable in milliseconds even at the project's small scale, but ugly and hard to reason about.

## Decision

Represent same-day availability as **fixed-width bitmaps** at 1-minute resolution and combine them with bitwise AND.

- One business day fits in `Math.ceil(minutesPerDay / 32)` `Uint32Array` words. A 12 h day = 720 minutes ≈ 23 words. A 24 h day = 1440 minutes = 45 words.
- For a given date we precompute, per Provider, an `available: BitMap` derived from
  `businessHours ∧ ¬closure ∧ ¬providerAbsence ∧ ¬(occupiedByExistingBookings + bufferBefore + bufferAfter)`.
- Per Resource, the same shape but with the holding-period extension across consecutive days.
- A candidate slot of duration `D` minutes is admissible at offset `i` iff `popcount((available >> i) & ((1 << D) - 1)) == D`. Implemented as a slide over words rather than bit-level loops.
- Provider × Resource pairing under "おまかせ" iterates Providers in TypeID-ascending order (deterministic) and pairs with the first Resource whose bitmap also admits the slot.
- `now` clears any minute prior to the current moment so past slots cannot be returned.

## Consequences

- Computation per day: O(P · R · M / 32) word-level operations. At P, R ≤ ~10 and M ≤ 1440 this is < 1 ms even cold.
- Property tests can assert invariants at the bitmap level (no overlap, monotonicity in bookings, deterministic ordering) — these are far stronger than per-slot example tests.
- The function is total and pure; `Date` and `Effect` do not appear in its body.
- Scaling to other deployments (longer days, different granularity) is changing two constants.

## Alternatives considered

- **Naïve nested loops**: simple to write, hard to test exhaustively, ~100× slower at typical sizes.
- **Interval trees**: optimal for sparse, very large interval sets. Overkill for ≤ tens of intervals per day; the constant factor of a BigInt / Uint32Array AND is hard to beat.
- **SQL on the fly**: pulls business logic into D1, defeating the pure-domain story.

## References

- SYSTEM.md §3.6, §4.5.4.
- Memory `feedback_smart_solutions_over_naive.md`.
