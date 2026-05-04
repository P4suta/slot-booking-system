# 0007. Item-handoff is not its own time slot in Phase 0

- Status: accepted
- Date: 2026-05-05
- Deciders: Yasunobu
- Tags: domain, scope

## Context

Services with `holdingDays > 0` (multi-day services where a Resource is occupied for several days) eventually need a handoff — the customer comes back to pick the item up. SYSTEM.md §3.3 left the "handoff slot" implementation open ("実装パターンは ADR で確定").

## Decision

In Phase 0, the handoff is **not modelled as a Provider time slot**. The booking entity continues to carry exactly one `TimeSlot` for the work itself. The Resource is held from the work day through the holding period; on the final day, staff hand the item back at whatever time the customer arrives.

A `Booking` therefore has:
- A single `TimeSlot` consuming Provider availability on the work day.
- A `holdingPeriod: { startDate, endDate }` consuming the Resource bitmap across the date range.
- No reserved Provider minutes on the handoff date.

If, after Phase 1 operations, queue management at handoff time becomes a real problem, a follow-up ADR can introduce an optional handoff slot **without** changing the Phase 0 schema (additive only).

## Consequences

- `Booking` stays a simple discriminated union with one `TimeSlot` — no array of slots.
- Slot calculation only needs to track Provider occupancy on the work day and Resource occupancy across the holding range. The bitmap representation (ADR-0012) handles both with the same primitives.
- Operational workflow: staff handle the handoff at the counter, no calendar coupling required.
- This is **scope** rather than **architecture**: the door is left open for a future ADR.

## Alternatives considered

- **(b) Embed a handoff TimeSlot in the same Booking**: forces `Booking.slots: ReadonlyArray<TimeSlot>`, which leaks complexity into the state machine and slot calculator.
- **(c) Spawn a child handoff Booking**: adds a parent/child relation that has no other use; Make illegal states unrepresentable becomes harder.

## References

- SYSTEM.md §3.3.
