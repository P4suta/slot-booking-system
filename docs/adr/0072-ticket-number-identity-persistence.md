# ADR-0072: Ticket-number identity persistence (Reorder withdrawal)

- Status: Accepted
- Date: 2026-05-12
- Supersedes (Reorder portion only): ADR-0065
- Refines: ADR-0050 (queue pivot), ADR-0051 (event-sourced queue),
  ADR-0062 (lane partitioning)

## Decision

Withdraw the `Reorder` operator action and the `Reordered` event
introduced by ADR-0065. The `displaySeq` field stays — it is still
the per-lane FIFO position assigned at Issue — but `displaySeq` is
now **append-only** in the operator surface: the only way to
re-order tickets relative to one another is by the lanes they are
issued into (`walkIn / priority / reservation`) and by which
ticket the operator next calls (`CallNext / CallSpecific /
CallBatch`).

Concretely the following are removed:

- `applyReorder` / `ReorderArgs` / `Reorder` use case
- `ReorderedEventSchema` / `ReorderedEvent` / `"Reorder"`
  `TicketCommand` literal / `"Reordered"` `TicketEventType`
- `rebalanceLane` projection helper + `applyEvent("Reordered")`
  case
- `POST /api/v1/queue/reorder` endpoint + `ReorderBodySchema`
- `QueueAction { type: "Reorder", … }` dispatch variant
- The web staff page's 「先頭に移動」 button + `onReorderToHead`
  handler

`LaneMismatchError` is retained because `RescheduleTicket`
(ADR-0070) still raises it when a non-reservation ticket is
targeted; the docstring is updated accordingly.

## Context

ADR-0065 added `Reorder` so an operator could move a Waiting
ticket to a new position within its lane — typically pulling a
reservation customer who arrived early ahead of two later
reservation peers. The action shipped as a single-lane FIFO
rebalance with `displaySeq` rebuilt to a contiguous `1..N`.

Two problems surfaced once the lane chain (ADR-0067) and the
named-call actions (ADR-0065) settled:

1. **Identity break.** A customer's `displaySeq` is the number
   they read off their physical / web ticket: 「あなたは #5 で
   す」. When operator `Reorder` runs, the projection rebuilds
   the lane and `displaySeq` of every Waiting peer in that lane
   shifts. A customer who took #5 may, without notification, be
   looking at "#7 — あと 4 名" the next time the WS feed pushes.
   The implicit contract — *the number on your ticket identifies
   you and your wait position* — is broken silently.

2. **Cost / use ratio.** The use cases `Reorder` was meant to
   cover are already covered by:
   - `CallSpecific` (operator picks any Waiting ticket regardless
     of lane / position) — handles the "VIP arrived, call them
     now" flow without rebalancing anyone else's `displaySeq`.
   - `priority` lane (ADR-0062) — the lane chain
     `priority > walkIn > reservation` pulls priority customers
     ahead automatically; manually issuing into the priority lane
     replaces "drag this person to the head".
   - `Reschedule` (ADR-0070) — for reservation customers who
     arrive outside their slot, swapping `appointmentAt` is the
     correct operation; their position then derives from the new
     slot, not from operator drag.

   Field estimate: `Reorder` would fire in fewer than 1% of
   operator-touch events in steady state; the action carries
   permanent UX, projection, and audit-log complexity that does
   not pay back.

## Trade-offs

| | Keep `Reorder` | **Withdraw `Reorder`** |
|--|--|--|
| Customer identity | breakable per operator click | persistent for the ticket's lifetime |
| Operator latitude | drag any Waiting ticket | `CallSpecific` + lane choice + `Reschedule` |
| Audit clarity | `Reordered` event noise on every rebalance | unchanged event log shape |
| Code surface | use case + event + projection helper + UI button + endpoint | none |
| Projection complexity | `rebalanceLane` recomputes lane on every event | append-only `displaySeq` |
| Operator regret cost | medium (mistakes shift everyone) | low (`CallSpecific` is targeted) |

The trade is a deliberate tightening: operators give up granular
within-lane drag, customers gain a stable number for the life of
their wait. The named-call actions (`CallSpecific` / `CallBatch`)
preserve operator agency over *who is served next* without
mutating anyone else's position.

## Consequences

- Customer-facing 整理券番号 (= `displaySeq`) is now an
  immutable ticket identifier from Issue through
  Served / NoShow / Cancelled. The web `/ticket` page can rely
  on it for the entire ticket lifetime.
- The projection's `displaySeq` invariants relax: per-lane
  contiguity (`1..N` after every event) is no longer guaranteed
  — gaps appear naturally as Waiting tickets are
  Called / Cancelled / NoShowed. The `head` / `headOfLane` /
  `nextDisplaySeqInLane` helpers continue to work because they
  sort by `displaySeq` rather than assume contiguity.
- The audit log no longer contains `Reordered` events; historical
  `Reordered` events from any production deployment that ran with
  ADR-0065 will fail to decode against the new
  `TicketEventSchema` union. **No production deployment carries
  this load** at the time of withdrawal, so no migration is
  needed; future deployments are clean.
- `LaneMismatchError` is now raised only by `RescheduleTicket`.

## Alternatives considered

- **Keep `Reorder` but warn the customer.** Reject — UX would
  need a per-rebalance push notification ("your number changed
  to #7"), which raises the operator-action cost (cognitive +
  notification budget) for a marginal use case.
- **Keep `Reorder` but freeze `displaySeq` per ticket and
  introduce a separate `priority` field.** Reject — adds a
  parallel ordering dimension on top of the lane chain
  (ADR-0067), which already encodes priority. Two ordering
  systems in one queue is exactly the complexity ADR-0067
  consolidated.
- **Soft-delete `Reorder` (keep code, hide UI).** Reject — keeps
  the use case + event + projection helper in the code with no
  caller, violating the project's "no half-finished
  implementations" rule.

## References

- ADR-0065 — original Reorder introduction (Reorder portion now
  superseded; CallSpecific / CallBatch retained).
- ADR-0067 — time-aware lane chain (the line "operator can
  `Reorder` (ADR-0065) within the lane" is updated to reference
  this ADR).
- ADR-0070 — reservation reschedule (covers the
  early-arrival-reservation flow cleanly).
