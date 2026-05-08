# 0029. EventSourcedRepository port + atomic save semantics

- Status: accepted
- Date: 2026-05-05
- Deciders: Yasunobu
- Tags: event-sourcing, ports-and-adapters, occ

## Context

Phase 0.5 had a split `BookingRepository` (snapshot CRUD) +
`EventStore` (append-only log) port pair. The two could drift —
storing a snapshot without its corresponding event, or vice versa,
left the system in an unrepresentable state. Phase 0.6 needed
write-path atomicity that the split made structurally impossible.

## Decision

Collapse both into one port:

```text
EventSourcedRepository.save(
  id,
  expected /* OCC revision */,
  events,
  next /* snapshot */,
)
```

The adapter implements `save` as an atomic sequence:

1. revision check (`SELECT MAX(seq) FROM booking_events`)
2. event log append (`INSERT INTO booking_events`)
3. snapshot upsert (`INSERT … ON CONFLICT DO UPDATE`)
4. outbox enqueue (`INSERT INTO outbox`)

DO local SQLite wraps the four in `ctx.storage.transactionSync`;
the in-memory adapter wraps them in `STM.commit` over three TMaps
(events, snapshots, byCode). Either all four commit or none.

The OCC check yields `ConcurrencyError({ expected, actual })` so
callers can re-read and retry; the actor model serialises writes
per DO instance, so the check is a fail-safe rather than a hot
contention point.

## Consequences

- **Pros**: structural impossibility of "snapshot drifted from
  event log"; one port surface across the two adapter implementations.
- **Cons**: callers must thread the `expected` revision through —
  the `_applyAndPersist` helper does this once for every command
  use case.

## References

- ADR-0028 (DO SQL storage)
- ADR-0030 (DO RPC + Either)
- ADR-0032 (Bitemporal + versioning + row codec)
- `packages/core/src/application/ports/EventSourcedRepository.ts`
- `packages/core/src/application/usecases/_applyAndPersist.ts`
