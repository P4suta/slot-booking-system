# 0033. Capability newtype + drop the bloom-filter pre-screen

- Status: accepted
- Date: 2026-05-05
- Deciders: Yasunobu
- Tags: authorization, indexing, simplification

## Context

Phase 0.5 used:

- a `by: "customer" | "staff" | "system"` literal for the actor of
  a state-changing event;
- a bloom filter over `bookingCode → bookingId` to dodge a slow
  (DO KV) lookup before the authoritative `findById`.

Phase 0.6's DO SQL layer made the lookup an O(1) UNIQUE-index hit
on `bookings.code`, removing the bloom's reason for existing.
Concurrently, Phase 0.7-β1 needs structured authorization that
encodes "who may issue what" at the type level — the bare actor
literal cannot express scope-based staff permissions.

## Decision

- New `Capability` newtype (`CustomerCapability` |
  `StaffCapability` | `SystemCapability`) at
  `packages/core/src/domain/auth/Capability.ts`. Schema-level
  narrowing on each Command variant restricts who may issue what
  (`Complete` ⊆ Staff; `Expire` ⊆ System). `apply` does the
  residual scope-membership check inside the Staff arm
  (`InsufficientCapability` on miss).
- Drop the bloom filter (commit `5cd33a9`). The
  `SecondaryIndexOps.findByKey(code)` port resolves to `eq(bookings.code, code)`
  in the DO adapter and a `byCode` TMap in the in-memory adapter.

## Consequences

- **Pros**: deterministic exact lookup (the bloom was a
  probabilistic data structure with non-zero false-positive rate);
  authorization is a first-class domain value; staff scope
  enforcement compiles instead of running.
- **Cons**: the customer credential pair (`bookingCode +
  phoneLast4`) now lives twice — inside `CustomerCapability` and
  inside the `authenticateCustomer` use case input. The use case
  builds the capability from the input, so there is no API
  duplication for callers, only an internal one-line lift.

## References

- ADR-0009 (PII discipline)
- `packages/core/src/domain/auth/Capability.ts`
- `packages/core/src/domain/booking/Command.ts`
- `packages/core/src/domain/booking/transitions.ts`
