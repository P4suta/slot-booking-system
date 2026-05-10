# ADR-0066: Slot value object + appointmentAt encoding

- Status: Accepted
- Date: 2026-05-11
- Refines: ADR-0050 (queue pivot), ADR-0051 (event-sourced
  queue), ADR-0052 (type-state Ticket), ADR-0062 (lane
  partitioning), ADR-0065 (operator-grade queue actions)

## Decision

The reservation lane (ADR-0062) gains a time axis. Every
`Ticket` carries `appointmentAt: NullOr<Instant>` as a common
field with the invariant

```text
lane === "reservation"  ⇔  appointmentAt !== null
```

verified by property test rather than encoded in `Schema`.
Walk-in / priority lane tickets carry `appointmentAt = null`
(their effective slot is "now"); reservation tickets carry
the booked slot's start instant.

The slot space is a **fixed bucket grid** with a small,
configurable granularity:

```text
Slot = (date: PlainDate, bucketId: BucketId, capacity: ℕ)
BucketId  = ℤ / (MINUTES_PER_DAY / granularity)
granularity ∈ { 15, 30, 60 }   (minutes)
```

Slot occupancy is a **commutative monoid** (counts add): two
reservations land in the same slot iff they share the same
`(date, bucketId)`. Allen interval algebra reduces here to the
3-relation set `{equals, before, after}` and the `overlaps`
predicate is the equivalence-class equality on `bucketId`.

The morphism `bucketOf : Interval → BucketId` is exposed in
`Slot.ts` so a future continuous-slot extension can drop in
without changing the public Schema.

## Context

ADR-0062 declared `Lane = "walkIn" | "priority" | "reservation"`
but explicitly deferred future-time exposure of the reservation
lane. The lane has been live for one sprint and is operationally
identical to walk-in (FIFO by `displaySeq`, ADR-0065) — a
customer who wants a 14:00 cut cannot tell the system about
14:00.

The motivation is **not** "switch the shop to fully reserved";
it is "an ordinary number-ticket shop wants to additionally let
customers pre-book slots." The walk-in queue stays primary;
reservations sit on top as a refinement of the existing
reservation lane.

Slot capacity is bounded (one stylist's chair, two dental
rooms). A discrete bucket model fits naturally. Continuous time
(any `[start, end)` minute pair) was considered and rejected:
the overlap check becomes Allen's full 13-relation algebra,
the staff UI becomes a Gantt chart instead of a column list,
and capacity bookkeeping needs interval trees.

## Trade-offs

|  | nullable common field | branded `Reservation` sub-union | separate `Reservation` aggregate |
|--|--|--|--|
| Schema width | one `NullOr` field | per-lane × state variant explosion | two aggregates, two event logs |
| Replay cost | one `applyEvent` switch | one switch + per-variant guard | two replays, dual SoT |
| Invariant pinning | round-trip property test | type-pinned | n/a |
| Legacy migration | `null` for all existing tickets | type-state recompute | dual-write window |
| ADR-0059 (event log SoT) | unchanged | unchanged | violated |
| Capacity overflow at issue | usecase guard | usecase guard | aggregate guard |

The chosen shape (NullOr on common field, invariant pinned in
test) keeps the event log single-source, leaves the replay
function shape unchanged, and surfaces the invariant where
readers look for it (the round-trip property) rather than
where Schema cannot enforce it. The branded sub-union is
structurally tighter but inflates the projection arms 5×
(`Waiting`, `Called`, `Serving`, `Served`, `NoShow` each gain a
walk-in / reservation cousin).

## Implementation

### Domain (`packages/core/src/domain/`)

- `queue/Slot.ts` (new):
  - `SlotGranularitySchema = Schema.Literals([15, 30, 60])`.
  - `BucketIdSchema` is a branded
    `Schema.Number.pipe(Schema.between(0, …))` whose upper
    bound is `MINUTES_PER_DAY / granularity - 1`.
  - `SlotSchema = Struct({ date, bucketId, granularity, capacity })`.
  - `bucketOf(at: Instant, tz: BusinessTimeZone, granularity)`
    pure.
  - `intervalOf(slot): { startAt: Instant, endAt: Instant }` —
    the `Interval → BucketId` inverse used by future
    continuous-slot work.
  - `overlaps(a: Slot, b: Slot): boolean` — `granularity` /
    `date` / `bucketId` triple equality.
  - `mergeOccupancy: (a: ℕ, b: ℕ) => ℕ` exported as the slot
    occupancy monoid (`(+)` with identity `0`).
- `queue/Ticket.ts`:
  - `CommonFields` gains `appointmentAt: Schema.NullOr(InstantSchema)`.
  - All variants spread the field; no per-variant refinement.
- `queue/TicketEvent.ts`:
  - `IssuedEventSchema` gains
    `appointmentAt: Schema.NullOr(InstantSchema)`.
- `queue/transitions.ts`:
  - `applyIssue` accepts `appointmentAt: Instant | null`.
- `domain/errors/Errors.ts` adds:
  - `SlotFullError`
  - `SlotInPastError`
  - `AppointmentRequiredForReservationLaneError`
  - `CheckInTooEarlyError` (consumed by ADR-0068)
  Each is registered in `errorClassRegistry`; the doc-drift
  gate consumes the new entries on `gen-error-docs`.

### Application

- `usecases/queue/IssueTicket.ts` splits its input into
  `IssueWalkIn | IssueReservation` (disjoint union).
  `IssueReservation` requires `appointmentAt` and runs a
  `slotOccupancy` capacity guard before `applyIssue`.

### Storage (`apps/default/src/server/`)

- `schema/tickets.ts` adds `appointmentAt: text("appointment_at")`
  (nullable) plus indexes
  `ix_tickets_appointment_at` and `ix_tickets_lane_appointment`.
- `schema/slots.ts` (new) holds the optional capacity-override
  table `slots(date, bucket_id, granularity, capacity)`. The
  default per-bucket capacity comes from env when no row matches.
- `durableObjects/schema.ts` runs an idempotent
  `ALTER TABLE tickets ADD COLUMN appointment_at` and creates
  the new table on `ensureDurableObjectSchema`.
- `adapters/DurableObjectTicketRepositoryLive.ts` extends
  `ticketColumns` and the row decoder.

## Consequences

- The customer-facing position (ADR-0062) is no longer the only
  thing a customer sees. A reservation customer reads
  `appointmentAt` directly; a walk-in customer continues to see
  position + ETA. `/ticket` conditionally renders a countdown
  when `appointmentAt !== null`.
- The capacity guard runs at **issue time** in the DO single-
  writer transaction. Concurrent `IssueReservation` requests
  on the same bucket serialise; the second-arriving caller
  sees `SlotFullError`. ADR-0061's hibernating WS still
  broadcasts the projection update.
- ADR-0050's "queue is the primary domain" stays true. A slot
  is an attribute of a ticket, not a separate aggregate.
- A future continuous-slot extension reuses `bucketOf` as the
  morphism `Interval → BucketId`; the public Schema for `Slot`
  does not change.
