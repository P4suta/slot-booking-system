# ADR-0075: Appointment-lapse auto-cancel

- Status: Accepted
- Date: 2026-05-21
- Refines: ADR-0066 (slot value-object), ADR-0067 (time-aware lane chain), ADR-0068 (check-in)
- Companion: [ADR-0071](./0071-supersede-serving-state.md), [ADR-0072](./0072-overdue-state-and-nudge-loop.md)

## Decision

A reservation-lane ticket (`lane === "reservation"`,
`appointmentAt !== null`) that has not been called (still
`state === "Waiting"`) and whose `appointmentAt + grace < now`
is auto-cancelled by the system with `reason ===
"appointment_lapsed"`.

A new `LapseAppointment` use case + `AppointmentLapsedEvent` is
introduced for traceability (the audit log records the lapse
explicitly rather than being a generic `Cancelled` with a magic
reason string), but the resulting ticket state is the same
`Cancelled` variant.

The customer can re-book by going to `/issue` and creating a
fresh reservation; there is no in-place ETA-adjustment or
slot-renegotiation UI.

Default `APPOINTMENT_GRACE_SECONDS = 600` (10 min). Env override
permitted.

## Context

User Q&A explicitly rejected the "customer reports late, we
keep their slot" flow:

> 遅れる人の対応を考えるとどんどん複雑化する。時刻を過ぎたら
> 予約を破棄するだけでいいと思う。再予約すればいいだけで。

The reservation-side complement of the `Overdue` flow (ADR-0072)
is therefore not a multi-step nudge but a clean sweep: if the
booked slot has passed by more than `grace` seconds without the
customer being called, the ticket is cancelled. The walk-in /
priority lanes are untouched (they have no `appointmentAt` to
lapse).

Two reasons to make this a separate event type rather than a
generic `Cancelled` with `reason === "appointment_lapsed"`:

1. **Audit clarity.** A future report ("how many reservations
   were lapsed last month?") joins on a typed event, not a
   string `reason`.
2. **Replay safety.** ADR-0059 totality is easier to enforce
   when each business outcome has its own event type — a typo
   in the reason string can't silently miscategorise the lapse.

## Trade-offs

| | Generic `Cancelled` with reason | **`AppointmentLapsed` event + `Cancelled` state** | New top-level `Lapsed` state |
|--|--|--|--|
| Reuses existing terminal `Cancelled` | yes | yes | **no** (new terminal) |
| Audit log discrimination | string match | **named event type** | named state |
| Type-state width | unchanged | unchanged | +1 |
| Customer-facing label difference | string-dependent | typed (web can branch on event type) | typed |
| Re-book story | "go to /issue" | "go to /issue" | "go to /issue" |

The middle column is the chosen balance — typed audit without
the type-state cost.

## Implementation

### Domain types

- `packages/core/src/domain/queue/TicketEvent.ts`:
  - New `AppointmentLapsedEventSchema`:

    ```ts
    type: "AppointmentLapsed",
    lapsedBy: Actor,            // always "system"
    appointmentAt: InstantSchema,  // the lapsed slot, for audit
    ```

  - Added to the top-level union and `ALL_TICKET_EVENT_TYPES`.

### Transitions

- `packages/core/src/domain/queue/transitions.ts`:
  - `applyLapseAppointment(t: Waiting, at, eventId) →
    {ticket: Cancelled, event: AppointmentLapsedEvent}`. The
    resulting `Cancelled` carries `reason === "appointment_lapsed"`
    and `cancelledBy === "system"`.
  - Pre-condition (enforced by use case, not transition):
    `t.lane === "reservation" ∧ t.appointmentAt !== null`. The
    transition function trusts the caller; the use case is the
    gate.
  - `TicketCommand` adds `"LapseAppointment"`.

### Use case

- `packages/core/src/application/usecases/queue/LapseAppointment.ts`:
  - Effect entry point, `system` actor only.
  - Pre-conditions:
    - `t.state === "Waiting"` (Called / Overdue tickets follow the
      ADR-0072 flow instead).
    - `t.lane === "reservation"`.
    - `t.appointmentAt !== null`.
    - `now ≥ t.appointmentAt + grace`.
  - Errors: `InvalidStateTransitionError` if predicates fail.

### Alarm tick

- Tick 4 of the `QueueShop.alarm()` sweep (per ADR-0072):
  - Scan tickets with `state === "Waiting" ∧ lane ===
    "reservation" ∧ appointmentAt + grace < now`.
  - For each, dispatch `LapseAppointment(ticketId)`.
  - The next `setAlarm()` candidate from this tick is the
    earliest `appointmentAt + grace` across all currently
    Waiting reservation tickets.

### Customer-facing surface

- `apps/web/src/routes/ticket/+page.svelte`:
  - When the displayed ticket is `Cancelled` and the event log
    contains an `AppointmentLapsed` for it, the cancellation
    card shows a distinct copy: 「予約時刻を過ぎたためキャンセル
    されました。再予約してください。」 with a link to `/issue`.
  - For all other `Cancelled` reasons the existing copy is
    unchanged.
- No new buttons. The customer's only response is to navigate
  to `/issue` and re-book.

## Consequences

- A reservation customer who misses their slot by 10 min sees
  their ticket flip to `Cancelled` automatically. They can
  re-book on the spot via `/issue` (subject to remaining slot
  capacity).
- Operational reports gain a typed signal for "how many
  reservations are being lost to lateness?" — a leading
  indicator for slot-sizing decisions.
- The `Overdue` flow (ADR-0072) applies only to tickets that
  have been `Called`. A reservation that lapses without ever
  being Called never enters `Overdue`; it goes straight
  `Waiting → Cancelled` via this ADR.
- Lane invariant from ADR-0066 (reservation ⇔ appointmentAt
  non-null) is enforced by the use case's predicate — a
  walk-in ticket with `appointmentAt = null` is structurally
  ineligible.

## Alternatives considered

- **"I'm running late" customer button with ETA input,
  re-queue at end-of-line if confirmed.** Rejected per user
  Q&A — added complexity, weak operational gain, easier to
  re-book.
- **No grace period (lapse at exactly `appointmentAt`).**
  Rejected — a 0-second grace would cancel customers who are
  in-transit / signalling-on-arrival. 10 min is the same
  threshold ADR-0068 uses for the customer-side check-in
  window; reusing it keeps the operational mental model
  symmetrical.
- **Lapse the slot even if `state === "Called"`.** Rejected
  — once Called the ticket is the operator's responsibility,
  not the timer's. The Overdue / nudge flow (ADR-0072) is the
  right layer.
- **New terminal state `Lapsed` distinct from `Cancelled`.**
  Rejected — adds type-state width, no client behavioural
  difference beyond the displayed copy. The typed event
  (`AppointmentLapsed`) gives audit-side discrimination
  without the state-machine cost.

## References

- Plan: `/home/yasunobu/.claude/plans/queue-radiant-harp.md`
- Companion ADR-0071 — `Serving` removal.
- Companion ADR-0072 — Overdue state + nudge loop (the Called-
  side complement of this sweep).
- ADR-0068 — `/issue` flow + check-in window (the re-book
  destination).
