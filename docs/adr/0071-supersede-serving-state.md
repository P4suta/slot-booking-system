# ADR-0071: Supersede `Serving` — fold the "at the counter" window into `Called` + `Overdue`

- Status: Accepted
- Date: 2026-05-21
- Supersedes: [ADR-0063](./0063-serving-state.md)
- Refines: ADR-0052 (type-state Ticket), ADR-0059 (event-log SoT)
- See also: [ADR-0072](./0072-overdue-state-and-nudge-loop.md) (the replacement mechanism for NoShow precision)

## Decision

Remove `Serving` from the `Ticket` discriminated union. `Called`
transitions directly to `Served` (when the staff finishes) or to
`Overdue` (when the auto-timer fires, see ADR-0072). The
`applyStartServing` transition, the `ServingStarted` event, and
the `POST /api/v1/tickets/:id/start-serving` route are removed.

The state machine becomes:

```text
Waiting → Called → Served | Overdue → Served | NoShow
```

`ServingStartedEvent` stays in the `TicketEvent` discriminated
union as `@deprecated` to preserve event-log totality (ADR-0059):
replay must handle historical records, but new emissions are
prohibited by lint.

## Context

ADR-0063 introduced `Serving` to tighten NoShow alarm precision:
the alarm sweeps `Called` only, so once a customer is at the
counter (`Serving`) they cannot be false-positively NoShowed.

Two operational signals invalidated this trade-off:

1. **The "Start Serving" button is dead weight.** Staff click it
   immediately after the customer steps up, and it carries no
   semantic difference from "Called" from the customer's
   perspective (ADR-0063 itself notes this). The button is a
   ritual the operator must perform to deactivate the NoShow
   alarm; it is not where they decide anything.
2. **The state machine has a better way to gate NoShow.** A new
   `Overdue` state (ADR-0072) is inserted between `Called` and
   `NoShow`, with system-initiated `MoveToOverdue` followed by a
   bounded nudge loop and only then a `MarkNoShow`. The customer
   has multiple chances to respond before the terminal transition.
   `Called` becomes the "operator is engaging the customer" state;
   the NoShow alarm fires `Called → Overdue` (not `Called →
   NoShow`), so a customer at the counter is not at risk.

Together these mean `Serving` no longer earns its row in the
state union.

## Trade-offs

| | ADR-0063 (Serving) | **This ADR (no Serving, with Overdue)** | Single `Called` (pre-0063) |
|--|--|--|--|
| Operator click on customer arrival | required (StartServing) | **none** | none |
| NoShow precision | tight (Called only) | tight (gated through Overdue) | conservative tail |
| Customer warning before NoShow | none | **N nudges** | none |
| Type-state width | 6 states | 6 states (swap Serving ↔ Overdue) | 5 states |
| Operator action surface | 4 (StartServing / Served / NoShow / Recall) | 3 (Served / NoShow / Recall) — Recall now valid from Overdue too | 3 |
| Event-log compatibility | n/a | **must replay legacy `ServingStartedEvent` as no-op** | n/a |

The Overdue path gives us the precision ADR-0063 wanted **and**
the multi-step nudge that ADR-0063 did not address, at the cost
of one no-op replay branch.

## Implementation

- `packages/core/src/domain/queue/Ticket.ts`: remove the
  `ServingSchema` variant and its export. `TicketState` is now
  `"Waiting" | "Called" | "Overdue" | "Served" | "NoShow" |
  "Cancelled"`.
- `packages/core/src/domain/queue/TicketEvent.ts`: keep
  `ServingStartedEventSchema` in the union with a `@deprecated`
  JSDoc tag and a comment pointing here. Remove the symbol from
  emission sites (use cases, transitions); the union membership
  is purely for replay totality.
- `packages/core/src/domain/queue/transitions.ts`:
  - Delete `applyStartServing`.
  - Broaden `applyMarkServed` to accept `Called | Overdue`.
  - Broaden `applyMarkNoShow` to accept `Called | Overdue`
    (system fires it on `Overdue` after N nudges; staff may
    fire it on either).
  - Broaden `applyCancel` to accept `Waiting | Called | Overdue`.
  - Broaden `applyRecall` to accept `Called | Overdue → Waiting`.
  - Remove `"StartServing"` from `TicketCommand`.
- `packages/core/src/application/usecases/queue/StartServing.ts`:
  delete.
- `apps/default/src/server/durableObjects/QueueShop.ts`: remove
  the `"StartServing"` `QueueAction` variant and its dispatch
  arm.
- `apps/default/src/server/http/router.ts`: remove `POST
  /api/v1/tickets/:id/start-serving`.
- `apps/web/src/routes/staff/+page.svelte`: remove the
  「対応開始」 button. The "Calling" column gains the action
  buttons (MarkServed / MarkNoShow / Cancel / Recall) that were
  previously split across "Calling" and "Serving" columns. A
  new "Overdue" column appears (ADR-0072) but it is conceptually
  the same column as "Calling" with the auto-timer fired.
- `apps/web/src/lib/api.ts`: remove `startServing`.

## Consequences

- The staff column count stays at 4 (Waiting / Called / Overdue
  / Done). The "Serving" column is replaced by "Overdue"; the
  rendered name and semantics change but the layout is
  unchanged.
- ADR-0009 PII retention TTLs apply to the same three terminal
  states (`Served / NoShow / Cancelled`). `Overdue` is active
  alongside `Waiting / Called` and lives until terminal.
- The customer-facing screen still treats `Called` and `Overdue`
  identically from the customer's perspective ("you have been
  called") — the audit and alarm semantics are operator-side
  only. (The nudge UI on the customer side is a new addition;
  see ADR-0072.)
- **Event-log replay**: a historical `ServingStartedEvent` is a
  no-op in the projector — the ticket's state stays `Called`
  rather than upgrading to a phantom state that no longer
  exists. This is safe because the only behavioural difference
  ADR-0063 hung on `Serving` was the NoShow alarm gate, and the
  gate is now implemented via `Overdue` regardless of historical
  state.

## Alternatives considered

- **Keep `Serving` and add `Overdue` on top.** Rejected — two
  intermediate states (`Called → Serving → ...` plus `Called →
  Overdue → ...`) bifurcate the post-call window without solving
  a new problem. `Overdue` already gates NoShow; `Serving` was
  purely a marker that NoShow is suspended, which is now the
  default once `Called` no longer auto-NoShows.
- **Auto-promote `Called → Serving` on a presence signal (door
  QR / customer screen tap).** Rejected — adds infrastructure
  (door QR rescan flow per ADR-0068) and a new failure mode
  (presence signal missed, staff has to fall back to a manual
  button). The "no button at all" outcome is cleaner.
- **Physically delete `ServingStartedEvent` from the union.**
  Rejected — violates ADR-0059 (event log is source of truth)
  and ADR-0013 totality; existing production events would fail
  the projector's exhaustiveness check.

## References

- Plan: `/home/yasunobu/.claude/plans/queue-radiant-harp.md`
- Superseded ADR-0063 (Serving state) — same file.
- Companion ADR-0072 — Overdue state + nudge loop.
- Companion ADR-0075 — appointment-lapse auto-cancel.
