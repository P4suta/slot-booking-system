# ADR-0073: Serving as derived classification (drops the Serving state)

- Status: Accepted
- Date: 2026-05-12
- Supersedes: ADR-0063 (Serving intermediate state)
- Refines: ADR-0050, ADR-0052, ADR-0059, ADR-0061, ADR-0071

## Decision

Withdraw the `Serving` domain state introduced by ADR-0063. The
ticket lifecycle collapses back to:

```text
Waiting → Called → Served | NoShow
              ↘ Cancelled (from Waiting / Called / PendingNoShow — see ADR-0074)
```

The "対応中 (now serving)" classification continues to exist on
the staff Kanban, but as a **projection-time derivation**: a
Called ticket whose `calledAt` is older than
`SERVING_THRESHOLD_MS` (env, default 30 s) renders in the 対応中
column; the rest renders in 呼び出し中. The two columns are
mutually exclusive subsets of the same underlying Called set.

Concretely the following are removed:

- `Serving` variant + `ServingSchema` from `Ticket.ts`
- `ServingStartedEventSchema` + `ServingStartedEvent` from
  `TicketEvent.ts`
- `applyStartServing` + `StartServing` use case + `"StartServing"`
  `TicketCommand` literal
- `applyEvent` `case "ServingStarted"` from `projection.ts`; the
  `Served` projection branch loses its `Serving`-source carry-
  through (`servingStartedAt` / `servingStartedBy` are gone from
  `Served` too)
- `servingTickets` projection helper
- `POST /api/v1/tickets/:id/start-serving` HTTP endpoint
- `QueueAction { type: "StartServing", … }` dispatch variant
- `startServing` web client + `onStartServing` handler + the
  「対応を始める」 button
- `state_Serving` paraglide message + `"Serving"` from
  `TicketState` union on the wire

`SERVING_THRESHOLD_MS` joins the env type at the HTTP boundary
(`apps/default/src/server/http/types.ts`) and the QueueShop DO.

## Context

ADR-0063 framed `Serving` as the operator-visible "now servicing"
state, with `applyStartServing` producing a `ServingStarted`
event when staff clicked 「対応を始める」 on the calling card.
The intent: separate "called the customer" from "actually with
the customer at the counter" so the NoShow alarm could stop
sweeping once service began.

In production-shape rehearsal three problems surfaced:

1. **The button is friction.** Once a staff member calls a
   customer, they walk to the counter and start serving — there
   is no decision to be made between Called and Serving. Adding
   a click that "marks the obvious" is the kind of operator
   ceremony the Tier B redesign (ADR-0062 / 0065 / 0067) spent a
   sprint removing. *One action, one fact* — calling = serving
   from the operator's lived experience.
2. **`servingStartedAt` is unreliable when manual.** The button
   is clicked when the staff member remembers, not when service
   actually starts. The audit field already drifts by 30–60 s in
   practice. A projection-time derivation (now − calledAt ≥
   threshold) is no less accurate and asks zero of the operator.
3. **NoShow alarm semantics don't need it.** ADR-0074 redirects
   the NoShow alarm into the new PendingNoShow grace path —
   started by staff, not by alarm-sweep on stale Called tickets.
   With the alarm gone, the original "sweeps Called only" cutoff
   that ADR-0063 carved out has no remaining caller.

User direction (2026-05-12 plan AskUserQuestion Q1) was
unambiguous: "完全に drop (Called → Served 直結)".

## Trade-offs

| | Keep `Serving` (ADR-0063) | **Withdraw `Serving` (this ADR)** |
|--|--|--|
| Operator clicks per customer | 3 (Call → StartServing → Served) | 2 (Call → Served) |
| `servingStartedAt` precision | manual click, drifts | derived from calledAt + threshold |
| Domain state count | 6 (Waiting/Called/Serving/Served/NoShow/Cancelled) | 5 (no Serving) |
| Event types | 9 (incl. ServingStarted) | 8 |
| Wire envelope shape | `calling[]` + `serving[]` | `calling[]` + `serving[]` (same — derived) |
| Customer-facing semantics | unchanged (Called and Serving look identical) | unchanged |
| Audit log "service start time" | event timestamp | infer from calledAt + threshold |
| Projection complexity | server holds Serving → Served carry-through | server splits Called by elapsed |

The trade-off is precise audit fidelity (fine-grained
`servingStartedAt` event) for operator-time. The audit consumers
(history column, EWMA service-time metric) work fine on the
derived value: `serving_duration ≈ servedAt - (calledAt + threshold)`
is within 30 s of the manually-clicked value, well under EWMA's
`α = 0.1` smoothing window.

## Consequences

- The dispatcher action surface drops from 9 to 8 variants
  (`StartServing` removed). DO `dispatch` switch loses one case;
  the rest is unchanged.
- `MarkServed` now narrows its source to `Called` only. The
  defensive `t.state === "Serving"` carry-through inside
  `applyMarkServed` is gone, simplifying the projection's
  `case "Served"` branch by ~10 lines.
- `CancelTicket` and `RescheduleTicket` source narrows to
  `Waiting | Called` (previously `Waiting | Called | Serving`).
  PendingNoShow joins both sources in ADR-0074.
- `isActiveForHandle` (ADR-0069) also drops the `Serving` arm —
  the active set is `{Waiting, Called}` (later +PendingNoShow).
  All `state IN (...)` SQL queries follow.
- Projection wire (`v: 4` envelope) does **not** bump version. The
  `serving[]` array semantics changed from "tickets in Serving
  state" to "Called tickets past the elapsed threshold", but the
  shape is identical and consumers (web staff Kanban) already
  treat the array opaquely.
- The `"Serving"` literal disappears from `state` enums in
  `openapi.ts`, `apps/web/src/lib/api.ts` `ProjectionEntry` /
  `Ticket` unions, and the paraglide `state_Serving` message.
- Any historical event log that contains a `ServingStarted`
  event will fail to decode against the new `TicketEventSchema`
  union. **No production deployment carries this load** at the
  time of withdrawal, so no migration is needed.
- The 30 s `SERVING_THRESHOLD_MS` default is a soft UX choice;
  shops with longer call→counter walks can override via env.

## Alternatives considered

- **Keep `Serving` but auto-fire `ServingStarted` on a timer.**
  Rejected — the auto-fire would race with `MarkNoShow` (alarm
  sees a stale Called ticket → marks NoShow before the
  ServingStarted timer fires, or the timer fires before
  PendingNoShow can intervene). Adds two race conditions for the
  benefit of preserving an event whose timestamp was already
  unreliable when manual.
- **Keep `Serving` but make `StartServing` automatic on customer
  CheckedIn.** Rejected — `CheckedIn` (ADR-0068) is an explicit
  customer action that fires before `Called` (when the customer
  walks into the lobby), not after. Repurposing it would break
  ADR-0068's own contract.
- **Soft-delete `Serving` (keep code, hide UI).** Rejected — no
  half-finished implementations rule. The state and event would
  linger in the audit log without producers.

## References

- ADR-0063 — original Serving introduction (now superseded).
- ADR-0072 — Reorder withdrawal (companion withdrawal that
  followed the same "drop the operator-clicked intermediate
  state" reasoning).
- ADR-0074 — PendingNoShow grace period (the path that absorbed
  the NoShow alarm semantics ADR-0063 had originally guarded).
