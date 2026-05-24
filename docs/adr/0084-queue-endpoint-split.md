# ADR-0084: `/queue` endpoint split into anonymous + staff paths

- Status: accepted
- Date: 2026-05-24
- Refines: ADR-0083 (OpenAPI-derived web client types) — closes the
  one shape that ADR-0083 had to leave manual.
- Touches: ADR-0061 (DO hibernating WS) — the WS broadcast still
  carries the anonymous projection only; the split mirrors the
  request side onto the same separation.

## Context

`GET /api/v1/queue` returned **two different JSON shapes** based on
the request's `x-staff-token` header:

- **Anonymous** (no header): `{ waitingCount, laneCounts, calling,
  overdue, waitingPreview, nextReservationDeadline }` with each
  array element a `ProjectionEntry` carrying only
  `id / seq / lane / displaySeq / appointmentAt` — no PII.
- **Staff** (valid header): the same envelope but with the arrays
  carrying full `Ticket` rows (PII inclusive: `nameKana`,
  `phoneLast4`, `freeText`), plus a `terminal` history slice.

The shape-shifting pattern shipped pre-OpenAPI; it was the
expedient encoding when the queue projection was a single
hand-rolled handler. It calcified into three downstream problems:

1. **`feedback-shape-shifting-endpoint-guard` memory** — the web
   client had to wrap `/queue` responses in a runtime shape guard
   (`StaffShopState` vs `ShopState`) because the TypeScript type
   couldn't tell which arm the server would emit. The guard was
   correct but fragile: a missing header on a staff dashboard
   silently degraded the response to the anonymous shape, and the
   client crashed downstream on `terminal: undefined`.
2. **OpenAPI cannot model header-discriminated responses cleanly.**
   ADR-0083 derived the web client's wire types from
   `docs/openapi.json` for every endpoint *except* `/queue`. The
   `ShopState` / `StaffShopState` aliases had to stay hand-written
   with a flagged-as-manual comment in `apps/web/src/lib/api.ts`.
   The end-to-end schema-driven story closed (server schema →
   OpenAPI → web types) except for this one stop-gap.
3. **The router's handler became a 90-line conditional.** The
   shared computation (sort by `displaySeq`, compute EDF deadline,
   produce lane counts) ran in one branch; the response shaping
   forked on the header. Refactoring either projection meant
   editing both inline emit-statements.

The clean fix is the obvious one: two endpoints, two
statically-known shapes. The web client picks the path; the server
guards `/queue/staff` with the existing `requireStaff` helper.

## Decision

Split `GET /api/v1/queue` into two paths:

- **`GET /api/v1/queue`** — anonymous projection. Returns the
  PII-free envelope unconditionally. Any `x-staff-token` /
  `Authorization` / cookie header is ignored.
- **`GET /api/v1/queue/staff`** — full-ticket projection. Requires
  the `requireStaff` capability (header / Bearer JWT / cookie).
  Missing or invalid credential returns 401, matching every other
  staff endpoint.

The shared computation lives in `computeQueueBuckets(tickets)`
(`apps/default/src/server/http/router.ts`). It returns
`{ waiting, calling, overdue, laneCounts, nextReservationDeadline }`
already sorted; each handler folds it into its own response
envelope. The staff handler additionally computes the `terminal`
8-element history slice — that part is staff-only because the
slice exposes per-ticket PII through the row's `nameKana` /
`phoneLast4`.

OpenAPI now models both paths explicitly:

- `components.schemas.ProjectionEntry` carries the
  `{ id, seq, lane, displaySeq, appointmentAt }` shape (plus
  optional `nudgeCount` for the overdue arm) and is `$ref`'d from
  the anonymous response.
- `components.schemas.Ticket` (already lifted by ADR-0083) is
  `$ref`'d from the staff response.

The web client (`apps/web/src/lib/api.ts`) is now fully
OpenAPI-derived for the queue projection:

```ts
export type ShopState = paths["/queue"]["get"]["responses"]["200"]["content"]["application/json"]
export type StaffShopState =
  paths["/queue/staff"]["get"]["responses"]["200"]["content"]["application/json"]
export type ProjectionEntry = components["schemas"]["ProjectionEntry"]
```

The manual `ShopState` / `StaffShopState` / `ProjectionEntry`
declarations are deleted. `staffShopState()` now calls
`/queue/staff` instead of toggling a header.

## Considered alternatives

1. **Keep the shape-shifting handler, model it in OpenAPI via
   `oneOf` + a vendor extension for header discrimination.**
   Rejected — OpenAPI 3.1 has no standard way to discriminate
   response variants by request header. Tools like
   `openapi-typescript` would emit a union the client has to
   narrow at runtime, returning us to the runtime shape guard
   that ADR-0083 wanted to delete.
2. **Two endpoints with the same response envelope, response
   body lifted into a discriminated union.** Same problem at the
   type level + still has runtime narrowing. Two paths with
   *distinct* shapes is structurally honest.
3. **Three endpoints (`/queue`, `/queue/staff`, plus a
   merge-back compatibility shim).** Rejected — the web client
   is the only caller. No external API consumer exists yet, so
   the compatibility shim has no consumer and would rot.

## Consequences

**Positive:**

- The shape-shifting endpoint is gone. The `feedback-shape-
  shifting-endpoint-guard` failure mode (a staff dashboard
  silently degrading to anonymous payload on a forgotten header)
  is structurally impossible — the path either matches the
  staff route and 401s on missing creds, or it matches the
  anonymous route and returns the small envelope.
- ADR-0083's schema-driven story closes end-to-end for `/queue`
  too. The manual `ShopState` / `StaffShopState` aliases are
  deleted; both flow from `paths["/queue"]` / `paths["/queue/
  staff"]`.
- The OpenAPI document now carries `ProjectionEntry` as a
  shared component, available to future endpoints that emit the
  same PII-free projection shape (e.g. a future per-lane query).
- The router handler shrinks: shared sort + projection logic in
  one helper, two thin route bodies that pick the response
  shape.

**Negative / accepted:**

- The web client's `staffShopState()` URL changed. Any caller
  (including external clients consuming `docs/openapi.json` if
  any existed) needs an update. There are none today; the
  apps/web migration ships in this same change.
- The WS broadcast at `/queue/feed` is unchanged — it carries
  the anonymous projection only, the same as it always did. A
  follow-on (perhaps `/queue/feed/staff` for an authenticated
  WS feed) is conceivable but out of scope.
- Slight backwards-compat regression for any operator who was
  hitting `GET /queue` with `x-staff-token` via curl and
  expecting the staff shape. The fix is `s/queue/queue\/staff/`
  in their script; an integration test pins the contract.

**Out of scope:**

- An authenticated `/queue/feed/staff` WS variant — same
  shape-shifting question for the WS broadcast. Not in this
  ADR.
- Pagination on the `terminal` slice (currently fixed at 8).
- A `/queue/lane/{lane}` per-lane endpoint. Conceivable; not
  needed yet.

## Implementation

Touched paths:

- **`apps/default/src/server/http/router.ts`** — extracted
  `computeQueueBuckets(tickets)` + `projectAnonymous(ticket)`
  helpers. Replaced the single `GET /queue` handler with two
  handlers: anonymous (no guard, always anonymous payload) and
  `/queue/staff` (requireStaff guard, full-Ticket payload).
- **`apps/default/src/server/http/openapi.ts`** —
  `ProjectionEntry` lifted into `components.schemas`. Both
  paths declared explicitly with their full response envelopes.
  The legacy "Anonymous payload exposes lane / displaySeq /
  appointmentAt + calling[] + overdue[] arrays; staff payload
  carries the full ticket rows" footnote is dropped (the schema
  is now self-describing).
- **`docs/openapi.json`** — regenerated (~84 KB; the staff path
  pulls in another envelope on top of the anonymous one).
- **`apps/web/src/generated/openapi.d.ts`** — regenerated;
  exports `ProjectionEntry` as a root alias.
- **`apps/web/src/lib/api.ts`** — `ShopState` / `StaffShopState`
  / `ProjectionEntry` switched from hand-written to
  `paths[...]` extractions. `staffShopState()` calls
  `/api/v1/queue/staff`; the legacy `x-staff-token` toggle is
  removed from the anonymous code path entirely.
- **`apps/default/test/integration/_harness/sample-requests.ts`**
  — new `staffQueueProjection(staffHeaders)` builder.
- **`apps/default/test/integration/router/router.smoke.integration.test.ts`**
  — three new assertions: anonymous `/queue` does NOT carry
  `terminal`, `/queue/staff` without a token returns 401, and
  `/queue/staff` with a valid token returns the terminal slice.
- **`apps/default/test/integration/router/openapiSnapshot.integration.test.ts`**
  — the path-coverage pin gained `/queue/staff`.

Adversarial probes still expected at the boundary:

- `GET /queue` — always returns the anonymous envelope, ignores
  any auth header.
- `GET /queue/staff` without credential — 401
  `MissingStaffCapability`.
- `GET /queue/staff` with `x-staff-token` — 200 + full Ticket
  rows + `terminal` array.
- `GET /queue/staff` with invalid token — 401, same as missing.
