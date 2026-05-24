import type { NonEmptyReadonlyArray, TicketId } from "@booking/core"
import { Result, Schema } from "effect"
import type { Context, Hono } from "hono"
import type { QueueAction, QueueResult, QueueShop } from "../durableObjects/QueueShop.js"
import {
  CallBatchBodySchema,
  CallNextBodySchema,
  CallSpecificBodySchema,
  decodeTicketIdParam,
  dispatchDecodeFailure,
  IssueTicketBodySchema,
} from "./boundarySchemas.js"
import { parseJsonBody } from "./parseJsonBody.js"
import type { RateLimitNamespace } from "./rateLimit.js"
import { rateLimitMiddleware } from "./rateLimit.js"
import type { Env } from "./types.js"

/**
 * ADR-0082 — schema-driven HTTP router registry.
 *
 * The existing imperative router (`router.ts`) hand-writes the same
 * ceremony around every action-dispatch endpoint: optional rate-limit
 * middleware → optional staff guard → `:id` decode → body parse +
 * Effect-Schema decode → `QueueAction` construction → DO RPC dispatch
 * → response envelope (with optional status flip). The earlier
 * schema-first decisions stop short at this last reflex:
 *
 *   - ADR-0076 puts the action surface behind a single discriminated
 *     union (`QueueAction`) the DO dispatches via
 *     `Match.discriminatorsExhaustive("type")`.
 *   - ADR-0078 derives the OpenAPI document from a single
 *     `boundaryRegistry` of Effect-Schemas.
 *
 * What's still hand-written is the connective tissue between an HTTP
 * verb-path and a `QueueAction`. This module supplies it: every
 * action-dispatch endpoint is described by a declarative `RoutingEntry`
 * and `buildRouterFromRegistry` materialises the entries onto a Hono
 * app. New endpoints land as a single entry; bug fixes to the
 * ceremony (decode-failure status, envelope shape, future audit log
 * hook, …) land once and propagate.
 *
 * Scope deliberately narrowed to **action-dispatch** endpoints —
 * those that call `stub.dispatch(action)`. The router still owns:
 *
 *   - direct DO method endpoints (`getTicketById`, `listTickets`,
 *     `register/unregisterPushSubscription`) — these are a different
 *     paradigm; mixing them into the same generator would erode the
 *     abstraction the same way a `customHandler` escape hatch would,
 *   - the truly-special endpoints `/staff/login` (JWT exchange),
 *     `/openapi.json` (static), `/queue/feed` (WS upgrade),
 *   - the customer/staff-branching `/tickets/:id/cancel` and
 *     `/tickets/:id/reschedule` — both pick a body schema based on
 *     auth state, which is domain complexity rather than HTTP
 *     boilerplate. Forcing them through a hook would multiply the
 *     generator's surface for two endpoints' worth of branching.
 *
 * The narrowing is the architecture: a uniform path for the uniform
 * thing, and the rest stays explicit.
 */

/**
 * Decoded inputs passed to `buildAction`.
 *
 * `body` is the schema-decoded request body when `bodySchema` is
 * declared. When `allowEmptyBody` is also set, an empty payload
 * decodes as the schema applied to `{}`. When no `bodySchema` is
 * declared, `body` is `undefined`.
 *
 * `ticketId` is exposed only on the `WithTicketId` variant — entries
 * registered via `defineRouteWithTicketId` have a `:id` path
 * parameter and the generator decodes it into a branded `TicketId`
 * before calling `buildAction`. Entries registered via `defineRoute`
 * have no `:id` segment and the type of `buildAction`'s parameter
 * doesn't carry the field at all, so `ticketId as TicketId` casts
 * are structurally impossible.
 */
type RouteContext<TBody> = { readonly body: TBody }
type RouteContextWithTicketId<TBody> = RouteContext<TBody> & {
  readonly ticketId: TicketId
}

/**
 * The shared shape every entry carries — the type-safe `buildAction`
 * lives on the specific `WithTicketId<TBody>` / `NoTicketId<TBody>`
 * variants exported via `defineRouteWithTicketId` / `defineRoute`.
 * The registry array is typed as the erased union so heterogeneous
 * entries can coexist; the helper functions narrow the per-entry
 * `TBody` at definition time so the action construction stays
 * checked.
 *
 * `bodySchema` uses `Schema.Codec<TBody>` — the effect-v4 shape with
 * default `E = TBody, RD = RE = never` (what every boundary schema
 * in `boundarySchemas.ts` ships with).
 */
type RoutingEntryBase = {
  readonly path: string
  readonly rateLimit?: RateLimitNamespace
  readonly requireStaff?: boolean
  readonly bodySchema?: Schema.Codec<unknown, unknown>
  /**
   * When set, an empty request body is treated as `{}` and passed
   * through `bodySchema` for normal decoding. ADR-0062
   * `/queue/call-next` is the motivating case — operators can call
   * with no body (preferred-lane chain default) or with `{ lane }`.
   */
  readonly allowEmptyBody?: boolean
  /**
   * Override the response status. The default is 200; ADR-0069
   * `IssueTicket` uses 201 for fresh issues and 200 for the
   * idempotent-merge variant — that policy is expressed here.
   */
  readonly successStatus?: (result: QueueResult) => number
}

export type RoutingEntry =
  | (RoutingEntryBase & {
      readonly hasTicketId: true
      readonly buildAction: (ctx: RouteContextWithTicketId<unknown>) => QueueAction
    })
  | (RoutingEntryBase & {
      readonly hasTicketId: false
      readonly buildAction: (ctx: RouteContext<unknown>) => QueueAction
    })

/**
 * Runtime collaborators the generator delegates to. Injected
 * rather than imported so unit tests can supply lightweight fakes
 * (no Cloudflare bindings, no DO stub) and so a future router cut
 * over can swap envelope / guard implementations without touching
 * the registry.
 */
export type RoutingDeps = {
  readonly stub: (env: Env) => DurableObjectStub<QueueShop>
  readonly dispatchEnvelope: (result: QueueResult, status?: number) => Response
  readonly failResponse: (
    status: number,
    tag: string,
    code: string,
    extra?: Record<string, unknown>,
  ) => Response
  readonly requireStaff: (c: {
    req: { header: (k: string) => string | undefined }
    env: Env
  }) => Promise<{ ok: true } | { ok: false; res: Response }>
}

/**
 * Define an entry whose `path` carries the `:id` parameter. The
 * generator decodes `:id` into a branded `TicketId` before invoking
 * `buildAction`, so the entry's handler sees a non-nullable
 * `ticketId` — no casts needed at the call site. The template-
 * literal constraint on `path` keeps `/api/v1/tickets/:id/check-in`
 * legal while ruling out `/api/v1/queue` at the definition site.
 */
const defineRouteWithTicketId = <TBody = undefined>(entry: {
  readonly path: `${string}:id${string}`
  readonly rateLimit?: RateLimitNamespace
  readonly requireStaff?: boolean
  readonly bodySchema?: Schema.Codec<TBody, unknown>
  readonly allowEmptyBody?: boolean
  readonly buildAction: (ctx: RouteContextWithTicketId<TBody>) => QueueAction
  readonly successStatus?: (result: QueueResult) => number
}): RoutingEntry => ({ ...entry, hasTicketId: true }) as unknown as RoutingEntry

/**
 * Define an entry whose `path` has no `:id` parameter. The handler
 * receives `body` only — there is no `ticketId` on the context.
 */
const defineRoute = <TBody = undefined>(entry: {
  readonly path: string
  readonly rateLimit?: RateLimitNamespace
  readonly requireStaff?: boolean
  readonly bodySchema?: Schema.Codec<TBody, unknown>
  readonly allowEmptyBody?: boolean
  readonly buildAction: (ctx: RouteContext<TBody>) => QueueAction
  readonly successStatus?: (result: QueueResult) => number
}): RoutingEntry => ({ ...entry, hasTicketId: false }) as unknown as RoutingEntry

/**
 * The set of action-dispatch endpoints. Ordering is stable for the
 * pin test; new entries append to the bottom unless a thematic
 * neighbour belongs nearby.
 */
export const routingRegistry: readonly RoutingEntry[] = [
  // ADR-0068 — customer arrival audit. No staff guard (customer-
  // initiated); rate-limited per IP in line with the rest of the
  // customer-handle surface.
  defineRouteWithTicketId({
    path: "/api/v1/tickets/:id/check-in",
    rateLimit: "RL_VERIFY",
    buildAction: ({ ticketId }) => ({ type: "CheckIn", ticketId }),
  }),
  // ADR-0071 — staff: Called | Overdue → Served.
  defineRouteWithTicketId({
    path: "/api/v1/tickets/:id/served",
    requireStaff: true,
    buildAction: ({ ticketId }) => ({ type: "MarkServed", ticketId }),
  }),
  // ADR-0072 — staff: Called | Overdue → NoShow.
  defineRouteWithTicketId({
    path: "/api/v1/tickets/:id/no-show",
    requireStaff: true,
    buildAction: ({ ticketId }) => ({ type: "MarkNoShow", ticketId, actor: "staff" }),
  }),
  // ADR-0065 — staff: pull Called | Overdue back into Waiting.
  defineRouteWithTicketId({
    path: "/api/v1/tickets/:id/recall",
    requireStaff: true,
    buildAction: ({ ticketId }) => ({ type: "Recall", ticketId, actor: "staff" }),
  }),
  // ADR-0069 — customer ticket issue. Idempotent merge surfaces
  // as 200 OK; a fresh issue is 201 Created. The
  // `appointmentAt` carries on the wire as a string because the
  // DO RPC boundary structuredClones every arg and rejects
  // `Temporal.Instant`.
  defineRoute<Schema.Schema.Type<typeof IssueTicketBodySchema>>({
    path: "/api/v1/tickets",
    rateLimit: "RL_ISSUE",
    bodySchema: IssueTicketBodySchema,
    buildAction: ({ body }) => ({
      type: "IssueTicket",
      handle: { nameKana: body.nameKana, phoneLast4: body.phoneLast4 },
      freeText: body.freeText,
      ...(body.lane !== undefined ? { lane: body.lane } : {}),
      ...(body.appointmentAt !== undefined ? { appointmentAt: String(body.appointmentAt) } : {}),
    }),
    successStatus: (result) =>
      result.ok && "ticket" in result && result.merged === true ? 200 : 201,
  }),
  // ADR-0062 — staff: call next ticket. Empty body falls through
  // to the preferred-lane chain default; explicit `{ lane }` picks
  // a specific lane head. The empty-body affordance is widely used
  // by operator UIs that present a single "次へ" button.
  defineRoute<Schema.Schema.Type<typeof CallNextBodySchema>>({
    path: "/api/v1/queue/call-next",
    rateLimit: "RL_OPERATE",
    requireStaff: true,
    bodySchema: CallNextBodySchema,
    allowEmptyBody: true,
    buildAction: ({ body }) => ({
      type: "CallNext",
      actor: "staff",
      ...(body.lane !== undefined ? { lane: body.lane } : {}),
    }),
  }),
  // ADR-0065 — staff: call a specific Waiting ticket.
  defineRoute<Schema.Schema.Type<typeof CallSpecificBodySchema>>({
    path: "/api/v1/queue/call-specific",
    rateLimit: "RL_OPERATE",
    requireStaff: true,
    bodySchema: CallSpecificBodySchema,
    buildAction: ({ body }) => ({
      type: "CallSpecific",
      ticketId: body.ticketId,
      actor: "staff",
    }),
  }),
  // ADR-0065 — staff: atomic batch call. The schema enforces a
  // non-empty array at the boundary; the `[head, ...tail]` rebinding
  // here lifts that runtime guarantee to the `NonEmptyReadonlyArray`
  // type the `CallBatch` action expects.
  defineRoute<Schema.Schema.Type<typeof CallBatchBodySchema>>({
    path: "/api/v1/queue/call-batch",
    rateLimit: "RL_OPERATE",
    requireStaff: true,
    bodySchema: CallBatchBodySchema,
    buildAction: ({ body }) => {
      const ids = body.ticketIds
      const [head, ...tail] = ids
      // The schema's non-empty filter rules `head === undefined` out
      // at decode; the runtime assertion here is for type narrowing
      // only and is unreachable in production.
      /* v8 ignore next */
      if (head === undefined) throw new Error("call-batch: empty ticketIds slipped past schema")
      return {
        type: "CallBatch",
        ticketIds: [head, ...tail] as NonEmptyReadonlyArray<TicketId>,
        actor: "staff",
      }
    },
  }),
]

/**
 * Walk the registry and register every entry on the Hono app.
 * Behaviour is deliberately uniform — divergence between
 * endpoints expresses itself as RoutingEntry fields, not as
 * different handler shapes.
 */
export const buildRouterFromRegistry = (
  app: Hono<{ Bindings: Env }>,
  registry: readonly RoutingEntry[],
  deps: RoutingDeps,
): void => {
  for (const entry of registry) {
    const handler = async (c: {
      req: {
        param: (k: string) => string
        header: (k: string) => string | undefined
        json: () => Promise<unknown>
        text: () => Promise<string>
      }
      env: Env
    }): Promise<Response> => {
      if (entry.requireStaff === true) {
        const guard = await deps.requireStaff(c)
        if (!guard.ok) return guard.res
      }
      let ticketId: TicketId | undefined
      if (entry.hasTicketId) {
        const idR = decodeTicketIdParam(c.req.param("id"))
        if (Result.isFailure(idR)) {
          return deps.failResponse(404, "TicketNotFound", "E_DOM_TICKET_NOT_FOUND")
        }
        ticketId = idR.success
      }
      let body: unknown
      if (entry.bodySchema !== undefined) {
        let raw: unknown
        if (entry.allowEmptyBody === true) {
          // Hand-rolled empty-body tolerance — `parseJsonBody` rejects
          // empty payloads as `InvalidPayload`. ADR-0062 callers omit
          // the body entirely on the "next" affordance.
          try {
            const text = await c.req.text()
            raw = text.length > 0 ? JSON.parse(text) : {}
          } catch (err) {
            return deps.failResponse(400, "InvalidPayload", "E_VAL_PAYLOAD", {
              reason: err instanceof Error ? err.message : "non-json body",
            })
          }
        } else {
          const parsed = await parseJsonBody(c as never)
          if (!parsed.ok) {
            return deps.failResponse(parsed.status, parsed.tag, parsed.code, {
              reason: parsed.reason,
            })
          }
          raw = parsed.raw
        }
        const decoded = Schema.decodeUnknownResult(entry.bodySchema)(raw)
        if (Result.isFailure(decoded)) {
          const fail = dispatchDecodeFailure(decoded.failure)
          return deps.failResponse(fail.status, fail.tag, fail.code)
        }
        body = decoded.success
      }
      // The `hasTicketId` discriminator selects the matching
      // `buildAction` overload — `WithTicketId` entries see
      // `ticketId` as the branded `TicketId`, `NoId` entries see
      // only `body`. `ticketId` is guaranteed defined inside the
      // `hasTicketId` branch (the earlier `:id` decode would have
      // returned 404 otherwise); the explicit invariant throw makes
      // that contract visible instead of leaning on a non-null
      // assertion.
      let action: QueueAction
      if (entry.hasTicketId) {
        /* v8 ignore next 3 */
        if (ticketId === undefined) {
          throw new Error("routerRegistry invariant: hasTicketId entry without decoded ticketId")
        }
        action = entry.buildAction({ ticketId, body })
      } else {
        action = entry.buildAction({ body })
      }
      const result = await deps.stub(c.env).dispatch(action)
      const status = entry.successStatus !== undefined ? entry.successStatus(result) : 200
      return deps.dispatchEnvelope(result, status)
    }
    // Hono's `app.post(path, ...middleware, handler)` overload set
    // is not happy with a variadic spread when the middleware count
    // is conditional. Split into the two concrete calls — same
    // behaviour, types tighten.
    const honoHandler = handler as unknown as (c: Context<{ Bindings: Env }>) => Promise<Response>
    if (entry.rateLimit !== undefined) {
      app.post(entry.path, rateLimitMiddleware(entry.rateLimit), honoHandler)
    } else {
      app.post(entry.path, honoHandler)
    }
  }
}
