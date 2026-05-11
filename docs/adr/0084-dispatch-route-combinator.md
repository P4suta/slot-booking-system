# ADR-0084: dispatchRoute combinator + ROUTES descriptor table

- Status: Accepted
- Date: 2026-05-11
- Stage: D / S16
- Refines: ADR-0056 (Hono router)

## Decision

Replace `apps/default/src/server/http/router.ts`'s 19-call
`app.post(path, middleware, async (c) => { … })` inline ladder
with one declarative `RouteDescriptor[]` table that the router
walks at startup. Each descriptor names its method, path,
optional rate-limit namespace, and request-scoped `handle`
callback; the `dispatchRoute` combinator (`registerRoute`) maps
the descriptor onto the corresponding Hono `app.get` / `app.post`
registration.

```text
router.ts (facade, ~60 lines)
  ├── global middlewares (requestLog / securityHeaders / cors /
  │   envelopeLog / onError) — applied to the Hono app once
  └── registerRoutes(app, ROUTES) — walks every entry
                         │
                         ▼
                    routes.ts (table)
                  RouteDescriptor[19]
                         │
        ┌────────────────┼─────────────────┐
        ▼                ▼                 ▼
  staff login   customer-facing   staff-facing
                ticket/queue ops  ticket/queue ops
```

### Why a descriptor table

1. **One source of truth.** The same `ROUTES` array drives the
   production router *and* (in a follow-on stage) the OpenAPI
   document, so a route added in one place cannot drift from
   the other. The inline ladder had no enumerator — `openapi.ts`
   re-listed every endpoint and was the easiest place for drift
   to land silently.
2. **Cross-cutting concerns become one-line edits.** Tracing
   shape, response-time histograms, request-id headers all hook
   into `registerRoute` once and apply everywhere; the inline
   ladder needed 19 touchpoints.
3. **Path coverage is lint-checkable.** A future CI gate can
   walk `ROUTES` against the OpenAPI document and fail the
   build on missing entries — the inline `app.post` was
   invisible to such a check.

### Why we keep the handler logic inline

Each handler body (decode-body → guard → dispatch → response)
is too domain-specific to factor into a single shared
`(action, opts) => Response` combinator without leaking either
generality or precision (`/tickets/:id/late-acknowledge` reads
the ticket *before* dispatching; `/queue/feed` rewrites the URL
before delegating; `/slots` builds a bucket grid). The
descriptor table is therefore *structural* (one record per
endpoint) rather than *abstractive* (one combinator per
endpoint family) — the table reads like a route manifest, not
like a DSL.

### Shared helpers move into `_shared.ts`

`stub`, `dispatchEnvelope`, `failResponse`, `okJson`, and
`requireStaff` move out of the closure-scoped helpers inside
`buildQueueApi` and into `apps/default/src/server/http/_shared.ts`.
Each handler in `routes.ts` imports the small named utility set
it needs, which is a one-import boilerplate per file but a flat
import graph that dependency-cruiser can reason about.

## Consequences

- `router.ts` shrinks from 869 lines to ~60 (global middlewares
  + `registerRoutes(app, ROUTES)` + `return app`).
- `routes.ts` (~720 lines) becomes the new home of every
  endpoint body — but the file reads top-to-bottom as a single
  manifest, which is easier to audit than the prior ladder
  interleaved with helper definitions.
- A future stage can derive `openApiDocument` from `ROUTES`
  (the boundary schemas are already on each descriptor's
  decode-failure path, so the OpenAPI request bodies can fold
  off the same table). This ADR does *not* land that fold —
  it is reserved as a follow-on so the migration stays
  audit-friendly.

## Status

- 2026-05-11 — `routes.ts` + `dispatchRoute.ts` + `_shared.ts`
  land, `router.ts` shrinks to the facade. Behaviour and wire
  shapes are unchanged; the existing integration test suite
  is the regression oracle.
