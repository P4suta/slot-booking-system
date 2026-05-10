# ADR-0067: Time-aware lane chain (EDF on reservation head)

- Status: Accepted
- Date: 2026-05-11
- Refines: ADR-0062 (lane partitioning),
  ADR-0066 (slot value object + appointmentAt encoding)

## Decision

The static lane chain `priority > walkIn > reservation`
(ADR-0062) gains a time-aware promotion rule. When the head
reservation ticket has `appointmentAt ≤ now + grace`, it is
treated as the head of the chain — overriding `priority` and
`walkIn`.

Formally, the next-callable selector is:

```text
firstLaneWithCallable(snap, now, grace) =
    if eligibleReservation(snap, now, grace) then "reservation"
    else if head(snap, "priority")           then "priority"
    else if head(snap, "walkIn")             then "walkIn"
    else if head(snap, "reservation")        then "reservation"
    else null
```

where `eligibleReservation` returns true iff the
`appointmentAt`-min reservation Waiting ticket is within the
grace window. `grace` defaults to **5 minutes** and is tunable
via `EDF_GRACE_MINUTES` env.

The shape is **Earliest Deadline First (EDF)** restricted to
the reservation lane head: deadlines = `appointmentAt`,
scheduling horizon = `[now, now+grace]`.

## Context

ADR-0062 made `priority > walkIn > reservation` a static
declared chain. Once ADR-0066 attaches time to the reservation
lane, the static order is incorrect for the operationally
intended UX:

- A 14:00 reservation should jump ahead of walk-ins waiting
  since 13:30 **at 14:00** — not before, not after.
- A 15:00 reservation sitting in the queue at 14:00 is **not**
  ready to be called and should stay behind walk-ins until
  its window opens.

A naïve "always take reservation lane when non-empty" rule
fires a 15:00 reservation at 13:55, which no operator wants.
The static chain leaves a 14:00 reservation sitting while
walk-ins issued at 13:55 pass.

EDF is the right policy: callable iff the deadline is now-ish.

## Trade-offs

|  | static chain (ADR-0062) | **EDF on reservation head** | promotion (move to priority lane) | per-event scheduler |
|--|--|--|--|--|
| Honours slot time | no | yes | yes | yes |
| Selection is a pure projection | yes | yes | partial (mutates lane) | no |
| Operator override | `CallSpecific` | `CallSpecific` | `CallSpecific` + edit | tuning knobs |
| Test surface | small | small (eligibility predicate) | larger (lane mutation paths) | large (scheduler state) |
| `displaySeq` impact | none | none | rebalance on promotion | none |
| Audit clarity | high | high (action = `CallNext`) | medium (silent promotion) | low |

The EDF-restricted-to-reservation-head choice keeps the chain
function pure (no mutation), keeps `displaySeq` unaffected
(ADR-0065's per-lane FIFO semantics are unchanged), and the
operator's action stays `CallNext` — the **intent** is "call
the next callable", and the projection decides which lane that
lives in.

## Implementation

### Projection (`packages/core/src/domain/queue/projection.ts`)

- `firstLaneWithCallable(snap, now, grace): Lane | null`
  exported as the new chain selector.
- `firstLaneWithWaiting(snap)` retained as a **legacy alias**
  that calls `firstLaneWithCallable(snap, now, grace=0)` with
  any `Clock`. At `grace = 0` and all `appointmentAt = null`,
  the function is identical to ADR-0062's static chain — the
  migration boundary cleanly degenerates.
- `reservationsByDeadline(snap, now): readonly Waiting[]` —
  `appointmentAt` asc-sorted Waiting tickets in the
  reservation lane, used by the staff Kanban for slot chip
  display (ADR-0068).
- `slotOccupancy(snap, slot): number` — lane-and-bucket-keyed
  count over Waiting + Called + Serving (the booking is "live"
  as long as any of those states hold).

### Use-cases & DO

- `usecases/queue/CallNext.ts` reads `Clock` from the existing
  service and calls
  `firstLaneWithCallable(snap, clock.now(), GRACE_DURATION)`.
- `durableObjects/QueueShop.ts` reads `EDF_GRACE_MINUTES` from
  `env` (default 5) and threads it to the `CallNext` use-case.
- `broadcastProjection` payload version bumps to **v: 3** with
  the new fields `nextReservationDeadline: Instant | null` and
  `slotOccupancy: { slot, taken, available }[]`. v2 readers
  ignore unknown fields (the `v` discriminator from ADR-0061
  remains forward-compatible).

### Property tests (`packages/core/test/property/`)

- `edf-order.property.test.ts`:
  - eligibility: `appointmentAt ≤ now+grace ⇒ reservation
    lane head wins over priority head and walkIn head`.
  - non-eligibility: `appointmentAt > now+grace ⇒ chain order
    falls back to ADR-0062 default (priority > walkIn >
    reservation)`.
  - boundary: at `grace = +∞` reservation always wins (sanity).
  - degenerate: `grace = 0` and all `appointmentAt = null`
    behaves identically to ADR-0062's `firstLaneWithWaiting`.

## Consequences

- The wire projection (ADR-0061 v3) gains
  `nextReservationDeadline` and `slotOccupancy[]`, so the
  staff client renders the Kanban slot chip without a second
  fetch.
- A reservation's `displaySeq` (ADR-0065) is computed per-lane
  as before; EDF promotion does **not** rebalance `displaySeq`.
  If the operator rejects the EDF suggestion and uses
  `CallSpecific` on a walk-in instead, the reservation remains
  at the head and is selected on the next `CallNext`.
- `MarkNoShow` on a reservation that passed its slot triggers
  the existing NoShow alarm filter (state === "Called" only,
  ADR-0063); the alarm cutoff is unaffected by `appointmentAt`.
- A reservation past its window (e.g. customer 30 min late)
  stays in the reservation lane FIFO by `displaySeq`. The
  operator can `Reorder` (ADR-0065) within the lane or
  `MarkNoShow` to clear.
