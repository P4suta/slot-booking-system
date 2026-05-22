# ADR-0072: `Overdue` state + bounded nudge loop

- Status: Accepted
- Date: 2026-05-21
- Refines: ADR-0052 (type-state Ticket), ADR-0013 (total state transitions), ADR-0059 (event-log SoT)
- Companion: [ADR-0071](./0071-supersede-serving-state.md) (Serving removed), [ADR-0075](./0075-appointment-lapse-auto-cancel.md) (reservation-side sweep)
- See also: ADR-0073 / ADR-0074 (Phase 2 — Web Push transport for the nudges)

## Decision

Insert a new top-level state `Overdue` between `Called` and the
terminal `NoShow`. Three new transitions and one new event:

```text
Called  ─MoveToOverdue (system, timer)──→ Overdue
Overdue ─Nudge        (system, timer)──→ Overdue   (counter++)
Overdue ─MarkNoShow   (system N≥MAX, or staff)──→ NoShow
```

`Overdue` is also a valid source for the existing `MarkServed`,
`Cancel`, and `Recall` transitions — the customer can still
arrive late and be served, the operator can still cancel, and a
mistaken call can still be withdrawn.

The nudge loop fires `Nudge` events on a fixed cadence with a
hard cap. Per-ticket state carries `nudgeCount: number` and
`lastNudgedAt: Instant`, both folded from the event log
(ADR-0059), not held in DO RAM.

## Context

ADR-0063 made the NoShow alarm tight by gating it on `Called`
only. ADR-0071 then removes `Serving` because the manual
`StartServing` button carries no decision. That leaves a gap:
how do we gate NoShow now that `Called` is the only pre-terminal
state and we cannot wait indefinitely?

Two parallel requirements drive the design:

1. **The customer should hear about the impending NoShow more
   than once.** The pre-0071 alarm fired NoShow after a single
   timeout (300 s default) with no warning. Customers who were
   genuinely on their way had no opportunity to respond.
2. **The state machine must stay total (ADR-0013).** Every
   pre-terminal state must enumerate its outgoing transitions;
   the projector's exhaustiveness check must continue to pass.

`Overdue` is the smallest extension that satisfies both:
`Called → Overdue` happens automatically, `Overdue → NoShow`
takes multiple nudges first, and the operator surface gains no
new manual transitions (every `Overdue` exit is reachable from
`Called` already; the source-state guard simply widens).

The transport for the nudges (WebSocket broadcast vs. Web Push
VAPID) is separable from the state-machine question and is
covered in ADR-0073 / ADR-0074. Phase 1 uses WebSocket; Phase 2
adds Web Push.

## Trade-offs

| | Single NoShow timer | **`Overdue` + nudges** | Substate of `Called` |
|--|--|--|--|
| Pre-NoShow customer warning | none | **N times** | N times |
| Exhaustiveness of state machine | trivial | **explicit variant** | hidden in fields |
| Type-state phantom captures gate | yes | **yes** | no (no compile-time check) |
| Operator action surface | unchanged | unchanged | unchanged |
| Projection complexity | flat | one extra variant + 2 counters | counter on `Called` |
| Event log readable as audit | flat | **explicit `MovedToOverdue` + `Nudged` events** | hidden in payload |

The two competing shapes (top-level `Overdue` vs. fields on
`Called`) both work in TypeScript. The top-level shape was
chosen because (a) ADR-0052 already invests in type-state
discrimination, (b) the projector's exhaustiveness check is a
hard quality gate, and (c) the audit log reads more clearly when
the transition is a named event rather than an attribute update.

## Implementation

### Domain types

- `packages/core/src/domain/queue/Ticket.ts`:
  - New `OverdueSchema` variant:

    ```ts
    state: Schema.Literal("Overdue"),
    calledAt: Instant,
    calledBy: Actor,
    overdueAt: Instant,
    lastNudgedAt: Schema.NullOr(InstantSchema),
    nudgeCount: Schema.Number,  // 0 at MoveToOverdue, incremented per Nudge
    ```

  - `TicketState` adds `"Overdue"`. Terminal set is unchanged.

- `packages/core/src/domain/queue/TicketEvent.ts`:
  - New `MovedToOverdueEventSchema`:

    ```ts
    type: "MovedToOverdue",
    overdueBy: Actor,  // always "system" in practice; field for shape uniformity
    ```

  - New `NudgedEventSchema`:

    ```ts
    type: "Nudged",
    nudgedBy: Actor,             // always "system"
    nudgeCount: Schema.Number,   // value AFTER increment (1, 2, 3, …)
    channel: Schema.Literal("ws", "push"),  // ws in Phase 1, push in Phase 2
    ```

  - Both added to the top-level union and the
    `ALL_TICKET_EVENT_TYPES` list.

### Transitions

- `packages/core/src/domain/queue/transitions.ts`:
  - `applyMoveToOverdue(t: Called, at, eventId, overdueBy?) →
    {ticket: Overdue, event: MovedToOverdueEvent}`.
  - `applyNudge(t: Overdue, at, eventId, channel) → {ticket:
    Overdue, event: NudgedEvent}` — increments `nudgeCount`,
    sets `lastNudgedAt = at`.
  - `applyMarkServed`, `applyMarkNoShow`, `applyCancel`,
    `applyRecall` accept `Overdue` in addition to their existing
    source states (see ADR-0071 for the precise shape).
  - `TicketCommand` adds `"MoveToOverdue"` and `"Nudge"`.

### Use cases

- New: `MoveToOverdue.ts` — `system` actor only. Pre-condition:
  state === "Called". No customer-facing side-effect; this is
  the state transition itself. The follow-up `Nudge` is what
  reaches the customer.
- New: `Nudge.ts` — `system` actor only. Pre-condition:
  state === "Overdue", `nudgeCount < MAX_NUDGES`. Side-effect:
  publish via `PushChannel` port (Phase 2) or `WsBroadcast` port
  (Phase 1).
- Existing: `MarkNoShow.ts`, `MarkServed.ts`, `CancelTicket.ts`,
  `Recall.ts` widen their state guard to accept `Overdue`.

### Alarm sweep

`apps/default/src/server/durableObjects/QueueShop.ts` runs four
distinct tick predicates per alarm wake (the alarm clock is
shared; the sweep evaluates all four):

| Tick | Predicate | Action |
|--|--|--|
| 1 | `state === "Called" ∧ now - calledAt > OVERDUE_AFTER_CALLED_SECONDS` | dispatch `MoveToOverdue` |
| 2 | `state === "Overdue" ∧ (lastNudgedAt === null ∨ now - lastNudgedAt > NUDGE_INTERVAL_SECONDS) ∧ nudgeCount < MAX_NUDGES` | dispatch `Nudge` |
| 3 | `state === "Overdue" ∧ nudgeCount ≥ MAX_NUDGES ∧ now - lastNudgedAt > NUDGE_INTERVAL_SECONDS` | dispatch `MarkNoShow(actor: "system")` |
| 4 | (covered in ADR-0075) | dispatch `LapseAppointment` |

The next `setAlarm()` target is the minimum of the next firing
times across all four ticks.

Defaults (env-overridable):

- `OVERDUE_AFTER_CALLED_SECONDS` = 60
- `NUDGE_INTERVAL_SECONDS` = 90
- `MAX_NUDGES` = 3
- (`APPOINTMENT_GRACE_SECONDS` = 600, see ADR-0075)

The total nudge window before NoShow is `60 + 90 × 3 = 330 s`
(~5.5 min), close to the legacy `NO_SHOW_TIMEOUT_SECONDS = 300`
of ADR-0063 — the move from "one cliff at 5 min" to "three
warnings spread over 5.5 min" is intentionally non-disruptive.

### Customer-facing notification (Phase 1, transport-light)

`apps/web/src/lib/calledAlert.ts` is extended: when the
WebSocket feed delivers a projection where the customer's ticket
transitioned `Called → Overdue`, the existing chime + browser
notification fires a second time with a different label ("応答を
お願いします"). The de-duplication key changes from `calledAt`
to `(calledAt, nudgeCount)` so each successive `Nudged` event
triggers exactly once.

A user with the tab closed will miss Phase 1 nudges; that gap is
what Phase 2 (Web Push, ADR-0073) closes.

### Replay

- A historical `ServingStartedEvent` is no-op in the projector
  (per ADR-0071). The post-replay state is `Called`; the next
  alarm tick will route the ticket through `Called → Overdue` as
  if `Serving` had never existed.

## Consequences

- `Overdue` is active (non-terminal). `isTerminal()` continues
  to return `true` only for `Served | NoShow | Cancelled`.
- ADR-0009 PII retention is unchanged: `Overdue` lives until a
  terminal transition fires.
- The projector's event-by-event fold gains two case arms
  (`MovedToOverdue`, `Nudged`). The exhaustiveness check
  continues to pass because the union literal `type` adds those
  two strings.
- The staff dashboard gains a distinct "Overdue" column showing
  `nudgeCount / MAX_NUDGES` per ticket; the same action buttons
  apply as in "Called" (MarkServed / MarkNoShow / Recall /
  Cancel). The visual distinction prompts staff to look at the
  customer's screen / call them out by name.
- Customer-side audio fatigue is bounded by `MAX_NUDGES`. A
  customer who can't / won't respond after N nudges is NoShowed
  by `system` — operationally the same outcome as the pre-0071
  alarm, just deferred by ~30 s and accompanied by a recorded
  reason in the event log.

## Alternatives considered

- **Substate of `Called` (`nudgeCount` field on `CalledSchema`).**
  Rejected — see Trade-offs. Loses the type-state phantom and
  the exhaustiveness check on transitions; the event log loses
  named `MovedToOverdue` / `Nudged` events.
- **Single nudge with a longer overall window.** Rejected —
  carries no UX gain over the pre-0071 single-timer design and
  defeats the "more than once" requirement.
- **Customer-driven "I'm running late" reply that re-times the
  reservation.** Rejected by user Q&A — adds complexity (re-queue
  / time-shift mechanics) without justifying it against the
  simpler "if you're past your slot, re-book" policy in ADR-0075.
- **Email / SMS for the nudge transport instead of Web Push.**
  Rejected — would require collecting an email or phone number,
  violating ADR-0054 anonymity. Web Push uses an opaque
  subscription endpoint and is the transport of record (Phase 2,
  ADR-0073).

## References

- Plan: `/home/yasunobu/.claude/plans/queue-radiant-harp.md`
- Companion ADR-0071 — `Serving` removal.
- Companion ADR-0075 — reservation-side appointment-lapse
  auto-cancel (Tick 4 of the same alarm sweep).
- Pending ADR-0073 — Web Push transport for nudges (Phase 2).
- Pending ADR-0074 — Push subscription anonymity (Phase 2).
