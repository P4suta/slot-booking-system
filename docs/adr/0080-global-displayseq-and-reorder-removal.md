# ADR-0080: Global displaySeq + Reorder removal

- Status: accepted
- Date: 2026-05-22
- Supersedes: per-lane `displaySeq` parts of ADR-0065 (operator-grade
  queue actions); the Reorder transition + use case from ADR-0065
- Builds on: ADR-0079 (priority lane removal)

## Context

ADR-0065 established two coupled invariants:

1. `displaySeq` is **per-lane monotone** — each lane has its own
   1..N sequence. Two lanes can carry tickets with the same
   `displaySeq` simultaneously (walkIn #3 and reservation #3 both
   exist).
2. The Reorder action rebalances a lane's Waiting tickets to a
   contiguous `1..N` after each move, so the per-lane numbering
   stays gap-free.

Both invariants leaked into the product as user-visible problems:

- **`displaySeq` is the customer's 整理券番号**, but two customers
  could legitimately hold "整理券番号 3" at the same time (one in
  walkIn, one in reservation). When the operator calls "3 番", which
  customer responds? The customer's number isn't a unique identifier
  the way the system wires it.
- **The Reorder action no longer has a UI consumer.** The staff
  page's "先頭に移動" affordance was removed in earlier UX cleanups
  (ADR-0079 supplementary), and the apps/web client wrapper
  (`reorder()` in `apps/web/src/lib/api.ts`) was dropped at the same
  time. The server route `/api/v1/queue/reorder`, the boundary
  schema, the action dispatch, the use case, the transition, the
  `Reordered` event, the projection's `rebalanceLane` helper, and a
  dozen tests all keep paying maintenance cost for a feature with
  zero consumers.

Removing one without the other doesn't work:

- If we make `displaySeq` globally monotone but keep Reorder, the
  per-lane rebalance breaks global uniqueness (walkIn rebalances to
  `1..N` regardless of what `displaySeq` reservation has).
- If we drop Reorder but keep per-lane numbering, the duplication
  problem stays.

The two have to be reconsidered together.

## Decision

**`displaySeq` becomes globally monotone**: at issue time the new
ticket gets `max(displaySeq) + 1` across **every** ticket the
snapshot has ever seen, regardless of lane or state. The customer's
整理券番号 is now a unique identifier; no two tickets ever share it.

**The Reorder action is removed entirely** from the domain, the
event log shape, the server boundary, and the test harness:

- `Reorder` use case and `Reorder.ts` are deleted.
- `applyReorder` transition is deleted.
- `Reordered` event variant is removed from `TicketEventSchema`.
- `rebalanceLane` helper and the `Reordered` case in `applyEvent`
  are removed from `projection.ts`.
- `ReorderBodySchema`, the `boundaryRegistry` entry, the
  `/api/v1/queue/reorder` route, the `Reorder` action dispatch in
  `QueueShop`, and the `Reorder` variant of `QueueAction` all go.
- The `"Reorder"` discriminator drops out of `TicketCommand` and out
  of the `ALL_TICKET_EVENT_TYPES` list.

`LaneMismatchError` stays — `RescheduleTicket` and `LapseAppointment`
still raise it for the reservation-only invariant they enforce.

Implementation rename: `nextDisplaySeqInLane(snap, lane)` →
`nextDisplaySeq(snap)`. The function loses its `Lane` parameter and
returns the global max+1.

## Consequences

**Positive:**

- The customer's 整理券番号 is a stable, unique identifier from the
  moment the ticket is issued until the moment it's served / no-shown
  / cancelled. The operator-side ambiguity ("which lane's 3?") is
  gone.
- One transition, one event variant, one use case, one HTTP route,
  one boundary schema, one projection helper, one openapi registry
  entry, and ~10 test cases all disappear. The remaining domain has
  fewer branches in the dispatch surface.
- The integration test harness's `Lane` arbitrary already narrowed
  to two values (ADR-0079); the property fold doesn't have to fight
  Reorder rebalances anymore.

**Negative / accepted:**

- Persisted state carrying `Reordered` events or pre-ADR-0080 ticket
  rows whose `displaySeq` happens to collide across lanes will
  decode-fail or produce a snapshot the new code's "global unique"
  assumption doesn't guarantee. Like ADR-0079, this requires a wipe
  + re-migrate for in-dev installations and a one-shot rewrite for
  production.
- The customer's number is now monotone forever — a shop running
  for months sees numbers grow without bound (#1234, #2701, …).
  Per-day reset is a credible future enhancement; this ADR doesn't
  pin it. If we want it, it's a `nextDisplaySeq` policy change
  (e.g., reset at the day boundary in the shop timezone) without
  touching the event log shape.
- Reorder removal forecloses an operator-driven manual queue
  shuffle. Given there was no UI for it and the EDF time-aware lane
  chain (ADR-0067) already handles "this reservation is due" without
  manual intervention, the operational gap is empty.

**Out of scope:**

- Per-day `displaySeq` reset (note above).
- Re-introducing operator promote/demote between lanes (would need a
  separate transition; would also need an auth / audit surface).

## Implementation

Touched paths:

- `packages/core/src/domain/queue/Lane.ts` — comment refreshed; no
  semantic change here, both lanes survive.
- `packages/core/src/domain/queue/TicketEvent.ts` —
  `ReorderedEventSchema` and its entry in `TicketEventSchema` /
  `ALL_TICKET_EVENT_TYPES` removed.
- `packages/core/src/domain/queue/transitions.ts` — `applyReorder`
  removed; `"Reorder"` dropped from `TicketCommand`.
- `packages/core/src/domain/queue/projection.ts` — `rebalanceLane`
  + `Reordered` case removed; `nextDisplaySeqInLane(snap, lane)`
  renamed to `nextDisplaySeq(snap)` and globalised.
- `packages/core/src/application/usecases/queue/IssueTicket.ts` —
  calls `nextDisplaySeq(snap)`.
- `packages/core/src/application/usecases/queue/Reorder.ts` — deleted.
- `packages/core/src/application/usecases/queue/index.ts` — drops
  the `Reorder.js` re-export.
- `apps/default/src/server/durableObjects/actions.ts` — `Reorder`
  variant removed from `QueueAction`.
- `apps/default/src/server/durableObjects/QueueShop.ts` — dispatch
  branch + import removed.
- `apps/default/src/server/http/boundarySchemas.ts` —
  `ReorderBodySchema` removed.
- `apps/default/src/server/http/openapiRegistry.ts` — registry
  entry removed.
- `apps/default/src/server/http/router.ts` — `/api/v1/queue/reorder`
  route + import + docblock entry removed.
- `apps/default/test/integration/_harness/sample-requests.ts` —
  `reorder()` helper removed.
- `packages/core/test/{domain,application,property}/**` — Reorder
  tests dropped; `nextDisplaySeq` global-monotone test added.

Adversarial probes still expected at the new boundary:

- `POST /api/v1/queue/reorder` → 404 (route gone).
- Two issues in different lanes: `t1.displaySeq !== t2.displaySeq`
  always, regardless of order or lane.
- `nextDisplaySeq(snap)` on a snapshot with tickets across both
  lanes returns `max + 1`, never restarting per lane.
