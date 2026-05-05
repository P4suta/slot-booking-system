# 0032. Bitemporal events + version literal + schema-driven row codec

- Status: accepted
- Date: 2026-05-05
- Deciders: Yasunobu
- Tags: event-sourcing, schema, bitemporal

## Context

Phase 0.5 events carried a single `at: Instant` timestamp; the row
codec for the read-side `bookings` projection was hand-rolled.
Phase 0.6 needed:

1. **Back-dating** — staff entry retroactively records the moment
   an event happened in the domain timeline, distinct from when it
   was written.
2. **Schema evolution** — the ability to add a v2 event variant
   without breaking replay over historical v1 events.
3. **Round-trip safety** — `Booking → row → Booking` lossless
   under every variant; today's hand-rolled codec is one variant
   away from a silent drift.

## Decision

- Every event carries `occurredAt` (domain timeline, may be
  back-dated) + `recordedAt` (write timestamp, always
  `Clock.nowInstant`) + `version: Schema.Literal(1)`.
- The `Booking` snapshot is encoded via a schema-driven row codec
  (`BookingFromRow`) that round-trips every variant under
  `Schema.encode/decode`.
- Replay reads events through `upcastToLatest` (ADR-0036, Phase
  0.7-α5 placeholder) so unparsable / older shapes are handled at
  the boundary.

## Consequences

- **Pros**: bitemporal queries are first-class; the row codec is
  derived rather than maintained; v2 events plug in via an
  upcaster registry without touching `applyEvent`.
- **Cons**: every event variant carries a literal `version: 1`
  field today (one extra byte on the wire). Acceptable for the
  uniform forward-migration story.

## References

- ADR-0029 (EventSourcedRepository)
- ADR-0036 (Schema as source of truth)
- `packages/core/src/domain/events/BookingEvent.ts`
- `packages/core/src/domain/events/Upcaster.ts`
- `packages/core/src/infrastructure/schema/BookingRow.ts`
