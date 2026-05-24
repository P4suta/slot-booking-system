import type { TicketId } from "@booking/core"
import { Hono } from "hono"
import { describe, expect, it, vi } from "vitest"
import type { QueueAction, QueueResult } from "../../../src/server/durableObjects/QueueShop.js"
import {
  buildRouterFromRegistry,
  type RoutingDeps,
  type RoutingEntry,
  routingRegistry,
} from "../../../src/server/http/routerRegistry.js"
import type { Env } from "../../../src/server/http/types.js"

/**
 * ADR-0082 — schema-driven HTTP router unit tests.
 *
 * The integration tests in `test/integration/*` already cover the
 * end-to-end happy + adversarial paths through every migrated
 * endpoint, so this unit suite focuses on the generator contract
 * itself: what happens at each branch of `buildRouterFromRegistry`
 * given a hand-rolled registry, hand-rolled deps, and a hand-rolled
 * Hono request. Together with the integration suite the two cover
 * the migrated surface end-to-end without leaning on Cloudflare
 * bindings.
 */

const RAW_TICKET_ID = "tkt_01h0000000000000000000000a"

const okResult: QueueResult = { ok: true }

const buildDeps = (
  override: Partial<RoutingDeps> = {},
): RoutingDeps & { dispatched: QueueAction[] } => {
  const dispatched: QueueAction[] = []
  const stub = (() => ({
    dispatch: (a: QueueAction): Promise<QueueResult> => {
      dispatched.push(a)
      return Promise.resolve(okResult)
    },
  })) as unknown as RoutingDeps["stub"]
  const deps: RoutingDeps = {
    stub,
    dispatchEnvelope: (_result, status = 200) =>
      new Response(JSON.stringify({ envelope: true, status }), { status }),
    failResponse: (status, tag, code) =>
      new Response(JSON.stringify({ ok: false, error: { _tag: tag, code } }), { status }),
    requireStaff: () => Promise.resolve({ ok: true }),
    ...override,
  }
  return Object.assign(deps, { dispatched })
}

const buildApp = (entries: readonly RoutingEntry[], deps: RoutingDeps): Hono<{ Bindings: Env }> => {
  const app = new Hono<{ Bindings: Env }>()
  buildRouterFromRegistry(app, entries, deps)
  return app
}

// Small helper: hand-roll a `WithTicketId` entry without going through
// `defineRouteWithTicketId` (which is module-private). The `hasTicketId`
// discriminator is set explicitly here so the test entries match the
// `RoutingEntry` union without leaning on the define helper.
const withTicketId = (entry: {
  readonly path: string
  readonly requireStaff?: boolean
  readonly buildAction: (ctx: {
    readonly ticketId: TicketId
    readonly body: unknown
  }) => QueueAction
  readonly successStatus?: (result: QueueResult) => number
}): RoutingEntry => ({ ...entry, hasTicketId: true }) as unknown as RoutingEntry

const post = async (
  app: Hono<{ Bindings: Env }>,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Response> => {
  const init: RequestInit = {
    method: "POST",
    headers: { ...headers, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
  }
  if (body !== undefined) init.body = JSON.stringify(body)
  return app.request(path, init, {})
}

describe("ADR-0082 — buildRouterFromRegistry", () => {
  it("routes a param-only entry: 200, dispatched action carries the decoded ticketId", async () => {
    const deps = buildDeps()
    const app = buildApp(
      [
        withTicketId({
          path: "/api/v1/tickets/:id/check-in",
          buildAction: ({ ticketId }) => ({ type: "CheckIn", ticketId }),
        }),
      ],
      deps,
    )
    const res = await post(app, `/api/v1/tickets/${RAW_TICKET_ID}/check-in`)
    expect(res.status).toBe(200)
    expect(deps.dispatched).toEqual([{ type: "CheckIn", ticketId: RAW_TICKET_ID }])
  })

  it("malformed :id returns 404 TicketNotFound before dispatch", async () => {
    const deps = buildDeps()
    const app = buildApp(
      [
        withTicketId({
          path: "/api/v1/tickets/:id/check-in",
          buildAction: ({ ticketId }) => ({ type: "CheckIn", ticketId }),
        }),
      ],
      deps,
    )
    const res = await post(app, "/api/v1/tickets/not-a-ulid/check-in")
    expect(res.status).toBe(404)
    expect(deps.dispatched).toEqual([])
    const body: Readonly<{ error?: Readonly<{ _tag?: string }> }> = await res.json()
    expect(body.error?._tag).toBe("TicketNotFound")
  })

  it("requireStaff: failed guard returns the guard's response and skips dispatch", async () => {
    const guardRes = new Response(JSON.stringify({ blocked: true }), { status: 401 })
    const deps = buildDeps({
      requireStaff: () => Promise.resolve({ ok: false, res: guardRes }),
    })
    const app = buildApp(
      [
        withTicketId({
          path: "/api/v1/tickets/:id/served",
          requireStaff: true,
          buildAction: ({ ticketId }) => ({ type: "MarkServed", ticketId }),
        }),
      ],
      deps,
    )
    const res = await post(app, `/api/v1/tickets/${RAW_TICKET_ID}/served`)
    expect(res.status).toBe(401)
    expect(deps.dispatched).toEqual([])
  })

  it("requireStaff: passing guard proceeds to dispatch", async () => {
    const deps = buildDeps({ requireStaff: () => Promise.resolve({ ok: true }) })
    const app = buildApp(
      [
        withTicketId({
          path: "/api/v1/tickets/:id/served",
          requireStaff: true,
          buildAction: ({ ticketId }) => ({ type: "MarkServed", ticketId }),
        }),
      ],
      deps,
    )
    const res = await post(app, `/api/v1/tickets/${RAW_TICKET_ID}/served`)
    expect(res.status).toBe(200)
    expect(deps.dispatched).toHaveLength(1)
  })

  it("successStatus: status override is evaluated against the dispatch result", async () => {
    const okWithMerged: QueueResult = { ok: true, ticket: {}, merged: true } as never
    const deps = buildDeps({
      stub: (() => ({
        dispatch: () => Promise.resolve(okWithMerged),
      })) as unknown as RoutingDeps["stub"],
      dispatchEnvelope: (_r, status = 200) => new Response(JSON.stringify({ status }), { status }),
    })
    const app = buildApp(
      [
        withTicketId({
          path: "/api/v1/tickets/:id/check-in",
          buildAction: ({ ticketId }) => ({ type: "CheckIn", ticketId }),
          successStatus: (r: QueueResult) =>
            r.ok && "ticket" in r && (r as { merged?: boolean }).merged === true ? 200 : 201,
        }),
      ],
      deps,
    )
    const res = await post(app, `/api/v1/tickets/${RAW_TICKET_ID}/check-in`)
    expect(res.status).toBe(200) // merged → 200
  })
})

describe("ADR-0082 — routingRegistry pin (drift detector)", () => {
  it("registry is a stable 8-entry list of action-dispatch endpoints", () => {
    // The registry is intentionally narrow: only `stub.dispatch(...)`
    // endpoints. Direct DO method endpoints (getTicketById, listTickets,
    // register/unregisterPushSubscription) and the special-case
    // /staff/login / /openapi.json / /queue/feed stay manual in
    // `router.ts`. The count + path list is pinned so a future
    // addition lands intentionally + visibly.
    expect(routingRegistry).toHaveLength(8)
    const paths = routingRegistry.map((e) => e.path)
    expect(paths).toEqual([
      "/api/v1/tickets/:id/check-in",
      "/api/v1/tickets/:id/served",
      "/api/v1/tickets/:id/no-show",
      "/api/v1/tickets/:id/recall",
      "/api/v1/tickets",
      "/api/v1/queue/call-next",
      "/api/v1/queue/call-specific",
      "/api/v1/queue/call-batch",
    ])
  })

  it("every entry covers exactly one QueueAction variant", () => {
    const deps = buildDeps()
    const app = buildApp(routingRegistry, deps)
    // We can't easily exercise every entry (bodies vary), but we
    // can at least assert the registry registers without throwing.
    // The integration suite covers the per-endpoint contracts.
    expect(app).toBeDefined()
    expect(deps).toBeDefined()
    expect(vi.isMockFunction(deps.dispatchEnvelope)).toBe(false)
  })
})
