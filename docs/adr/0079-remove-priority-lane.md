# ADR-0079: Remove the priority lane

- Status: accepted
- Date: 2026-05-22
- Supersedes: priority-lane parts of ADR-0062 (lane partitioning) and
  ADR-0065 (operator-grade queue actions)
- Relates to: ADR-0067 (time-aware EDF chain — survives; the chain is
  just `walkIn > reservation` now)

## Context

`Lane` started as a three-value union — `walkIn | priority | reservation`
(ADR-0062). The lane was meant to let an operator route, say, a VIP
or a disability-accommodation customer ahead of the walk-in queue.
But the design that landed never delivered the operator routing:

1. **No operator surface to set or change `lane`.** The staff page
   exposes Reorder (intra-lane move) and CallNext (head-of-lane
   call), but nothing to **promote** a Waiting ticket to priority or
   **demote** one back to walkIn. So `lane` is fixed at issue time
   and forever frozen.

2. **The only writer of `lane === "priority"` is the customer.**
   `POST /api/v1/tickets` accepts a `lane` field in the request body
   with no authentication on the priority value. Any client — the
   customer's phone, a curl from anywhere — can self-issue with
   `lane: "priority"` and jump the queue. The boundary schema
   validated the *shape* of `lane` but not who was allowed to choose
   it. This is a real and exploitable abuse vector, not just a UX
   wart.

3. **The customer can't legitimately self-mark priority either.**
   No customer-facing surface explains the priority lane (no chip,
   no toggle, no help text). Even if it did, "anyone can mark
   themselves as priority" is the wrong incentive design — the
   honest customer doesn't, the dishonest one always does.

4. **`displaySeq` is per-lane** (ADR-0065), so the customer-visible
   "整理券番号" can repeat across lanes (walkIn #3 and priority #3
   both exist). The duplication confuses staff and customers alike.
   Removing priority shrinks the duplication surface from three
   lanes to two. (The walkIn ⇔ reservation duplication remains; a
   follow-up ADR may make `displaySeq` globally monotone.)

The lane existed as a placeholder for an operator workflow that
never shipped, while presenting an abuse surface that was always
shipped. We are paying ongoing costs (extra branches in chain
selection, extra UI affordances, extra test fixtures) for a feature
that delivers negative value.

## Decision

Remove the `priority` lane entirely:

- `LaneSchema = Schema.Literals(["walkIn", "reservation"])` (was
  three values). `Lane` is correspondingly narrowed.
- `PREFERRED_LANE_CHAIN = ["walkIn", "reservation"]` (was
  `["priority", "walkIn", "reservation"]`).
- `IssueTicketBodySchema.lane` only accepts the two remaining
  literals; a request body with `lane: "priority"` now fails
  boundary decode with `InvalidLane`.
- `LaneCounts` shape narrows to `{ walkIn, reservation }`. The
  worker-side `/api/v1/queue` projection emits only these two
  counts.
- Web UI removes the priority filter chip (`/staff`), the priority
  count chip (`/`), the `lane_priority` paraglide message, and the
  `lane-priority` CSS branch.

The ADR-0067 EDF lane chain (reservation pre-empts the static chain
when its head is within `now + grace`) is preserved verbatim — it
never depended on the existence of `priority`. The static chain just
falls through to `walkIn` instead of `priority`.

## Consequences

**Positive:**

- The customer can no longer self-mark as priority. The abuse vector
  is closed at the schema, not at the route handler.
- One fewer branch in every chain-selection and projection function.
  Tests, fixtures, and ADR cross-references shrink accordingly.
- Lane filter buttons on the staff page collapse from four (`全部 /
  通常 / 優先 / 予約`) to three (`全部 / 通常 / 予約`).

**Negative / accepted:**

- Any in-flight ticket with `lane === "priority"` in storage will
  fail Schema decode under the narrowed `LaneSchema`. The DO has
  PERSISTED state across migrations, so any pre-ADR-0079
  installation must be wiped or migrated. For the in-dev environment
  this means dropping `.wrangler/state/v3/do/default-QueueShop/`.
  For a production rollout (if one ever happens) we would need a
  one-shot rewrite migration to relabel priority → walkIn before
  this ADR can ship.
- The integration test harness's `Lane` type narrows to two values;
  property tests that explicitly exercised three lanes now exercise
  two.

**Out of scope (follow-up):**

- `displaySeq` is still per-lane and so still duplicates across the
  two remaining lanes. A follow-up ADR may make it globally
  monotone, but that pulls in the question of whether Reorder
  (which rebalances per-lane `displaySeq` to a contiguous `1..N`)
  stays or goes too. Reorder's only consumer was the staff page,
  which has already removed the affordance, so a global-`displaySeq`
  follow-up is realistic.

## Implementation

Touched paths:

- `packages/core/src/domain/queue/Lane.ts` — narrowed schema and chain.
- `packages/core/test/{domain,application,property}/**` — removed or
  updated every `lane: "priority"` site.
- `apps/default/src/server/durableObjects/QueueShop.ts`,
  `apps/default/src/server/http/router.ts`,
  `apps/default/src/server/http/openapi.ts` — `LaneCounts` shape and
  the staff projection now emit two counts.
- `apps/web/src/lib/{api,messages}.ts` — `Lane` and `LaneCounts`
  types narrow; `laneLabel("priority")` branch removed.
- `apps/web/messages/{ja,en}.json` — `lane_priority` deleted,
  `lane_explanation` updated.
- `apps/web/src/routes/{+page,staff/+page}.svelte` — priority chip /
  filter button / data-binding removed.

Adversarial probes still expected to succeed at the boundary:

- `POST /api/v1/tickets` with `{"lane":"priority", ...}` → 422
  `InvalidLane` (was: 200 + ticket created in the abusable lane).
- `GET /api/v1/queue` (any token) → response payload contains
  `laneCounts: { walkIn, reservation }` only.
