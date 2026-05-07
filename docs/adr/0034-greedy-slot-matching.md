# 0034. Greedy provider/resource matching for AvailableSlots

- Status: superseded by [ADR-0040](./0040-bipartite-slot-matching.md)
- Date: 2026-05-06
- Deciders: Yasunobu
- Tags: algorithm, determinism

## Context

`computeAvailableSlots` walks every candidate start at the
configured granularity and assigns one Provider + the required
Resource set per slot. The "right" matching algorithm at the
academic level is bipartite max-matching (Hopcroft-Karp / Hungarian
over a (slot, provider, resource) graph). Phase 0.7-α2 reviewed
whether the greedy first-match approach should be upgraded.

## Decision

Keep the greedy ID-ascending first-match. Reject Hopcroft-Karp /
bipartite optimisation.

## Rationale

- **Determinism** — the customer self-service flow needs the same
  world snapshot to produce the same slot list across calls.
  Bipartite max-matching has multiple optima for typical worlds;
  any tie-breaking rule is itself a determinism contract that
  recreates the greedy story at higher complexity.
- **Locality** — `availableSlots` is a single-day query; the
  customer picks one slot. Globally maximising slot count in a day
  has no UX value when only one slot from the list will be taken.
- **Fairness** — ID-ascending means staff can predict which
  Provider takes which slot during manual rescheduling.
- **Cost** — Phase 0.7-α2 already brings the candidate walk to
  `O(valid_starts)` via `Bitmap.findRunsOfLength`; bipartite
  matching would add a per-day O(V·E) sweep without measurable user
  benefit.

## Consequences

- **Pros**: deterministic, readable, fast (`O(span)` bigint
  AND-shifts per provider/resource).
- **Cons**: in pathological worlds (heavily-constrained
  multi-resource services), greedy may yield fewer total
  fillable slots than the global optimum. Acceptable; rare in the
  small-shop scale this project targets.

## References

- ADR-0012 (bitmap arithmetic)
- `packages/core/src/domain/slot/computeAvailableSlots.ts`
- `packages/core/src/domain/slot/Bitmap.ts`
