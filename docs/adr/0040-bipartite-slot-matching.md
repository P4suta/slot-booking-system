# 0040. Bipartite matching for slot resource assignment

- Status: superseded by [ADR-0050](./0050-queue-pivot.md) — the bipartite matcher is unused; the queue domain has no provider/resource pairing.
- Superseded-By: ADR-0050
- Date: 2026-05-07
- Deciders: Yasunobu
- Tags: algorithm, slot-search, supersedes-0034

## Context

`computeAvailableSlots` walks every candidate start at the configured
granularity and assigns one Provider plus the required Resource set
per slot. ADR-0034 chose a greedy ID-ascending first-match for the
resource selection on grounds of determinism, locality, fairness, and
cost.

The greedy is correct under the present model — every Resource has
exactly one type, `service.requiredResourceTypes` is a Set so types
are unique per service, and a per-type independent pick cannot create
a conflict with another type's pick. But the greedy is also a
*special-case-only* algorithm: it stops working the moment a resource
gains multi-type tags, fractional capacity, or weighted preferences.
Those generalisations are plausible: a "stylist chair" might also
serve as a "shampoo chair" in some shops; cross-trained equipment
patterns appear in many service domains beyond the reference one.

The codebase therefore lacks a general-purpose matching primitive.
Phase 3 wants algorithm-data separation everywhere; the slot search is
no exception.

## Decision

Replace the greedy ID-ascending first-match with bipartite
maximum-cardinality matching via Hopcroft-Karp's BFS-layered
augmenting-path algorithm (`packages/core/src/domain/slot/bipartite.ts`).
The original land of this ADR (Phase 2) used Kuhn's single-phase
augmenting-path predecessor; Phase 3 (PR#4 M11) upgrades the
implementation to Hopcroft-Karp for the production-grade `O(E·√V)`
asymptotic with the same `Adjacency → Matching` signature and tie-
break ordering. The matching is applied per slot:

- Left nodes are the requirement slots in the order
  `requiredTypes.values()` produces them.
- Right nodes are every available `(type, resource)` candidate at
  `startMin`, taken in ID-ascending order.
- Edges connect requirement L to candidate R when
  `candidates[R].type === requiredTypes[L]`.
- A perfect matching of size `requiredTypes.size` is the witness
  that the slot is feasible; anything less drops the slot.

ADR-0034 is superseded.

## Rationale

- **Generality.** Kuhn's algorithm is the standard formulation for
  this problem. Future generalisations (multi-typed resources,
  weighted preferences via switch to Hungarian / Munkres) become
  parameter changes rather than algorithm rewrites. ADR-0034's
  rejection rested on "we don't need it" — a YAGNI position that ran
  out the day a second-shape requirement appears.
- **Determinism.** The augmentation tries left nodes in input order
  and walks each left node's right-neighbour list in input order.
  Both inputs are ID-ascending throughout `computeAvailableSlots`, so
  the resulting matching is a function of the world snapshot — the
  same call returns the same matching across runs. The "multiple
  optima" concern in ADR-0034 §Rationale was about *unconstrained*
  matching; the constrained input-order tie-break gives one matching.
- **Locality vs. completeness.** Even when a customer takes only one
  slot from the result list, the result list itself is more correct
  with bipartite: greedy can drop a slot that a perfect matching
  would have admitted. Under the current single-type model this
  difference is zero, but the algorithm choice no longer carries the
  precondition that resources have one type.
- **Cost.** `O(E·√V)` per slot on V ≤ |requiredTypes| (typically ≤ 4)
  and E ≤ |required resources| (a few dozen) is operationally
  indistinguishable from greedy. The previous bench baseline
  (`computeAvailableSlots.bench.ts`) is unchanged within run-to-run
  noise. Hopcroft-Karp gives the algorithm an upper-bound advantage
  if the bipartite scale ever grows materially.

## Consequences

### Positive

- One general-purpose matching primitive in the slot module
  (`bipartite.ts`) — reusable for any future domain matching problem.
- Slot output is provably the largest feasible set per (start, day),
  not "whatever greedy produced".
- The algorithm-data separation makes a switch to weighted
  Hungarian (Munkres) a one-file edit.

### Negative

- One additional module to read; the per-slot loop in
  `computeAvailableSlots` gains an indirection through
  `matchBipartite`. The total LoC stays roughly flat because
  `pickResources` shrinks.
- Determinism now depends on a documented input-ordering invariant
  rather than "greedy obviously deterministic". The invariant is
  enforced upstream (`toSorted(idAsc)` on candidates) and
  cross-checked by the existing slot tests.

## References

- ADR-0034 (greedy slot matching, superseded by this ADR)
- ADR-0012 (bitmap arithmetic — input availability sets)
- `packages/core/src/domain/slot/bipartite.ts`
- `packages/core/src/domain/slot/computeAvailableSlots.ts`
- Kuhn 1955 — Hungarian-method formulation of the augmenting-path
  search.
