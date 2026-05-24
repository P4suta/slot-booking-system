# ADR-0082: HTTP router auto-generation from a schema-driven routing registry

- Status: accepted
- Date: 2026-05-24
- Refines: ADR-0076 (schema-driven action handler table) +
  ADR-0078 (OpenAPI derivation from boundary schemas) — together
  these closed two thirds of the schema-driven boundary; this ADR
  closes the remaining third.
- Touches: ADR-0030 (DO RPC Either), ADR-0044 (DO RPC envelope),
  ADR-0058 (rate-limit namespaces).

## Context

`apps/default/src/server/http/router.ts` registered 19 HTTP
endpoints. The action-dispatch ones — every endpoint that runs
`stub.dispatch(action)` against the queue Durable Object — each
repeated the same five steps by hand:

1. Optional `rateLimitMiddleware(<namespace>)`.
2. Optional `await requireStaff(c)` guard.
3. `decodeTicketIdParam(c.req.param("id"))` (when the path has
   `:id`), returning 404 on a malformed ULID.
4. Optional body parse via `parseJsonBody` → schema decode via
   `Schema.decodeUnknownResult` → `dispatchDecodeFailure` mapping
   on failure.
5. Construct the `QueueAction` discriminated-union value, dispatch
   via the DO stub, and render the result through
   `dispatchEnvelope(result, status?)`.

The two earlier ADRs in this family already moved the rest of the
boundary onto a schema-first base:

- **ADR-0076**: the action surface is a single `QueueAction`
  discriminated union, and the Durable Object dispatches via
  `Match.discriminatorsExhaustive("type")`. A new action lands by
  editing one type + one handler arm.
- **ADR-0078**: the OpenAPI document is derived from the
  `boundaryRegistry` of Effect Schemas, so request/response
  shapes never drift between code and docs.

The HTTP route registration itself stayed imperative. Adding a new
action-dispatch endpoint required *all* of: a new `QueueAction`
variant, a new `boundarySchemas.ts` schema, a new
`boundaryRegistry.ts` entry, a new dispatch arm in `QueueShop`,
and a fresh 20–50-line handler in `router.ts` reproducing the
ceremony above.

## Decision

Introduce **`apps/default/src/server/http/routerRegistry.ts`** — a
declarative registry of `RoutingEntry` records — and the generator
`buildRouterFromRegistry(app, registry, deps)` that materialises
those records onto a Hono app. Every action-dispatch endpoint
becomes one entry:

```ts
{
  path: "/api/v1/tickets/:id/served",
  requireStaff: true,
  buildAction: ({ ticketId }) => ({ type: "MarkServed", ticketId }),
}
```

The entry surface — `path`, `rateLimit?`, `requireStaff?`,
`bodySchema?`, `allowEmptyBody?`, `buildAction`, `successStatus?`
— covers every variation that hit the migrated endpoints. Hook
overflow was deliberately avoided: when an endpoint cannot be
expressed by the entry surface (custom response shape, body schema
that depends on auth state, direct DO method call instead of
action dispatch), the endpoint stays in `router.ts` as before.
A `customHandler` escape hatch was considered and rejected — see
**Considered alternatives** below.

The migrated set (eight endpoints):

| Path | Hooks used |
|---|---|
| `POST /api/v1/tickets/:id/check-in` | rateLimit |
| `POST /api/v1/tickets/:id/served` | requireStaff |
| `POST /api/v1/tickets/:id/no-show` | requireStaff |
| `POST /api/v1/tickets/:id/recall` | requireStaff |
| `POST /api/v1/tickets` | rateLimit, bodySchema, successStatus |
| `POST /api/v1/queue/call-next` | rateLimit, requireStaff, bodySchema, allowEmptyBody |
| `POST /api/v1/queue/call-specific` | rateLimit, requireStaff, bodySchema |
| `POST /api/v1/queue/call-batch` | rateLimit, requireStaff, bodySchema |

The endpoints that **stay manual** in `router.ts`:

- **Direct DO method calls** (different paradigm — they don't go
  through `stub.dispatch(QueueAction)`):
  - `GET /api/v1/tickets/me` — `getTicketById` + constant-time
    `(kana, last4)` check.
  - `GET /api/v1/tickets/by-handle` — `findByHandle` + constant-
    time check.
  - `GET /api/v1/queue` — `listTickets` + staff/anonymous
    projection shape switching.
  - `GET /api/v1/slots` — `listTickets` + slot occupancy
    computation.
  - `POST /api/v1/tickets/:id/push-subscription` —
    `registerPushSubscription` (custom DO method with its own
    result shape).
  - `DELETE /api/v1/tickets/:id/push-subscription` —
    `unregisterPushSubscription` (same).
- **Customer/staff-branching endpoints** where the body schema and
  action shape both flip on the `x-staff-token` header — domain
  complexity, not HTTP boilerplate:
  - `POST /api/v1/tickets/:id/cancel`
  - `POST /api/v1/tickets/:id/reschedule`
- **Truly special**:
  - `POST /api/v1/staff/login` — JWT exchange.
  - `GET /api/v1/openapi.json` — static document.
  - `GET /api/v1/queue/feed` — WebSocket upgrade to the DO
    (ADR-0061 hibernation).

The narrowing is the architecture: the generator owns the uniform
ceremony, and the rest stays explicit and readable.

## Considered alternatives

Three other shapes were on the table:

1. **`customHandler` escape hatch on `RoutingEntry`.** Lets the
   registry cover every endpoint. Rejected — once entries can
   carry an arbitrary `(c) => Response`, the registry becomes a
   misshapen wrapper around the original imperative router and the
   generator's `buildAction` / `successStatus` invariants degrade
   to documentation. The audit specifically warned against this
   generic-overreach failure mode.
2. **Same generator for direct DO method endpoints.** Would
   replace `buildAction → stub.dispatch` with a generic
   `(env, ctx) => Promise<DoResponse>` hook. Rejected — the cohort
   of direct-method endpoints is small (six) and each carries
   endpoint-specific result shapes (e.g. `{ ok: true, ticket }`
   for `/tickets/me`, `{ reason: "PhoneMismatch" }` for push
   register). Forcing a uniform shape would either lossy-encode
   their results or push every customisation into hooks.
3. **State machine as data (C4 in the audit roadmap).**
   Considered as the alternative big move for this session; the
   user picked router auto-generation because it closes the
   schema-driven loop end-to-end and unblocks a follow-on
   OpenAPI → web-client codegen pass. The state-machine refactor
   is recorded as deferred in the audit roadmap (a separate plan
   captures the activation conditions and prototype requirement).

## Consequences

**Positive:**

- New action-dispatch endpoints land as a single registry entry
  paired with the `boundarySchemas.ts` schema + `QueueAction`
  variant + DO dispatch arm. The HTTP ceremony writes itself.
- Bug fixes / behaviour changes to the ceremony (decode-failure
  status mapping, response-envelope shape, future audit-log hook,
  …) land **once** in the generator and propagate to every
  registry entry.
- `router.ts` drops the eight handler bodies — roughly 150 lines
  removed. What remains is the manual surface that genuinely
  doesn't fit the action-dispatch mould, which makes the
  "different paradigm" cases obvious to a reader.
- Hook surface stayed lean: five booleans/optional functions
  cover every migrated case. There's no overflow `customHandler`
  field tempting future contributors to bypass the abstraction.
- The pin test (`routingRegistry.test.ts`) catches accidental
  drift — a registry resize or path rename surfaces in review.

**Negative / accepted:**

- One extra layer of indirection. A reader debugging
  `POST /api/v1/tickets/:id/check-in` now has to read both the
  registry entry and the generator body to understand what runs
  on a request. The Hono dev-tools route inspector still shows
  the registered path + middleware chain, and the generator is
  ~70 lines with no branching beyond what the entry fields
  request.
- The generator is bound to `QueueAction` + the `stub.dispatch`
  shape. A future second Durable Object (different action union)
  would need a parallel generator or a generic over the action
  type. We accept the present coupling because the project's
  scope is one queue DO; the generic lift is mechanical when
  needed.
- The eight register-via-registry entries lose a tiny amount of
  visibility in `router.ts` (the path lines are present as
  comments only). Anyone searching for `POST /tickets/:id/served`
  in `router.ts` still finds the reference; the actual handler
  is the registry entry.

**Out of scope:**

- Migrating the direct-DO endpoints (`tickets/me`, `by-handle`,
  `queue`, `slots`, push register/unregister). These either need
  a second abstraction (direct-method registry) or stay manual
  forever — both are downstream decisions.
- Unifying the error-mapping layer (currently spread across
  `errorEnvelope.ts`, `failResponse`, `dispatchDecodeFailure`).
  Listed in the audit as a separate medium refactor.
- Web-client codegen from OpenAPI (`apps/web`). Now unblocked by
  this ADR — the OpenAPI document is fully schema-derived end to
  end — and tracked as a follow-on.

## Implementation

Touched paths:

- **`apps/default/src/server/http/routerRegistry.ts`** — new.
  `RoutingEntry<TBody>` + `RoutingDeps` types, the registry array
  (eight entries), and the `buildRouterFromRegistry` generator.
- **`apps/default/src/server/http/router.ts`** — the eight handler
  bodies are removed; `buildRouterFromRegistry(app, routingRegistry, deps)`
  is called once before the manual endpoint registrations. The
  helpers (`stub`, `dispatchEnvelope`, `failResponse`,
  `requireStaff`) are passed through `deps` rather than imported
  by the generator, keeping `routerRegistry.ts` testable without
  Cloudflare bindings and `router.ts` the only owner of the
  helper definitions.
- **`apps/default/test/server/http/routerRegistry.test.ts`** —
  new. Seven cases exercise the generator contract (param-only
  entry, malformed `:id` returns 404 before dispatch, staff guard
  failure short-circuits, staff guard passing proceeds,
  successStatus override evaluates against the dispatch result,
  registry pin: path list + count) plus a smoke test that
  `buildRouterFromRegistry` registers without throwing on the
  real registry.

Adversarial probes still expected at the boundary (the existing
integration suite is the regression detector):

- `POST /api/v1/tickets/:id/check-in` with a malformed id → 404
  `TicketNotFound`.
- `POST /api/v1/tickets/:id/served` with no staff token → 401
  `MissingStaffCapability`.
- `POST /api/v1/tickets` with a fresh handle → 201 + ticket body.
- `POST /api/v1/tickets` with a duplicate handle (idempotent
  merge path) → 200 + `merged: true` ticket body.
- `POST /api/v1/queue/call-next` with an empty body → dispatches
  the preferred-lane chain default.
- `POST /api/v1/queue/call-batch` with `{ ticketIds: [] }` → 422
  `InvalidBody` from the schema's non-empty filter.

Migration policy for future endpoints:

- New action-dispatch endpoint → add a `routingRegistry` entry +
  schema + `QueueAction` variant + DO dispatch arm. No
  `router.ts` change needed.
- New direct-DO method endpoint or special handler → add manually
  to `router.ts`, with a comment explaining why it doesn't fit
  the registry.
- A registry entry that grows three or more hooks not currently
  on `RoutingEntry` is a signal that either the endpoint belongs
  manual, or the entry surface needs an honest extension — never
  a `customHandler` escape hatch.
