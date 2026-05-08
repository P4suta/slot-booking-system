import { codeOf, parseCustomerHandleStrict, parseTicketId } from "@booking/core"
import { Result, Schema } from "effect"
import { Hono } from "hono"
import type { QueueAction, QueueResult, QueueShop } from "../durableObjects/QueueShop.js"
import { verifyStaffJwt } from "../security/jwt.js"
import { readSessionCookie, verifySession } from "../security/session.js"
import { timingSafeEqual } from "../security/timingSafeEqual.js"
import { handleStaffLogin } from "./auth/login.js"
import { DEFECT_STATUS, statusForTag } from "./errorEnvelope.js"
import { openApiDocument } from "./openapi.js"
import { rateLimitMiddleware } from "./rateLimit.js"
import { requestLog } from "./requestLog.js"
import { corsAllowlist, parseAllowlist, securityHeaders } from "./securityHeaders.js"
import type { Env } from "./types.js"

/**
 * Hono-based queue REST surface. The previous router walked manual
 * regex matches; Hono does the path-param + method dispatch with a
 * compiled trie and gives `c.req.param("id")` typed access. The
 * route bodies stay thin — Effect-Schema parses input, the DO stub
 * dispatches, the envelope helpers project errors to status codes.
 *
 * Endpoints (all `/api/v1` prefixed):
 *   POST  /tickets                 issue
 *   GET   /tickets/me              customer self-fetch
 *   POST  /tickets/:id/cancel      cancel (customer with handle, or staff)
 *   POST  /tickets/:id/served      staff: mark served
 *   POST  /tickets/:id/no-show     staff: mark no-show
 *   POST  /tickets/:id/recall      staff: recall (Called -> Waiting)
 *   GET   /queue                   shop state (PII for staff, anon otherwise)
 *   POST  /queue/call-next         staff: call next
 *   GET   /queue/feed              DO Hibernating WebSocket projection feed
 */

const FreeTextOrNull = Schema.NullOr(Schema.String)

const IssueTicketBodySchema = Schema.Struct({
  nameKana: Schema.String,
  phoneLast4: Schema.String,
  freeText: FreeTextOrNull,
})

const MyTicketQuerySchema = Schema.Struct({
  ticketId: Schema.String,
  nameKana: Schema.String,
  phoneLast4: Schema.String,
})

const CancelBodySchema = Schema.Struct({
  nameKana: Schema.String,
  phoneLast4: Schema.String,
  reason: Schema.String,
})

const StaffCancelBodySchema = Schema.Struct({
  reason: Schema.String,
})

const stub = (env: Env): QueueShop =>
  env.QUEUE_SHOP.get(env.QUEUE_SHOP.idFromName("shop")) as unknown as QueueShop

const dispatchEnvelope = (result: QueueResult, status = 200): Response =>
  result.ok
    ? new Response(JSON.stringify({ ok: true, ticket: result.ticket }), {
        status,
        headers: { "content-type": "application/json; charset=utf-8" },
      })
    : new Response(
        JSON.stringify({
          ok: false,
          error: { _tag: result.error._tag, code: result.error.code },
        }),
        {
          status:
            result.error._tag === "Defect"
              ? DEFECT_STATUS
              : statusForTag(result.error._tag as never),
          headers: { "content-type": "application/json; charset=utf-8" },
        },
      )

const failResponse = (
  status: number,
  _tag: string,
  code: string,
  extra: Record<string, unknown> = {},
): Response =>
  new Response(JSON.stringify({ ok: false, error: { _tag, code, ...extra } }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  })

/**
 * Staff capability guard — accepts three credential surfaces:
 *
 *   1. `x-staff-token: <secret>` header. Legacy shape kept for
 *      curl scripts + the local-dev workflow; constant-time
 *      compared with `STAFF_SESSION_SECRET` (ADR-0058).
 *   2. `Authorization: Bearer <jwt>` header. HS256 JWT issued
 *      by `POST /api/v1/staff/login`; verified through
 *      `jose.jwtVerify` (ADR-0055 follow-up).
 *   3. `Cookie: __Host-staff_session=<token>`. HMAC-signed
 *      cookie issued by the same login endpoint; verified
 *      through `verifySession` which itself folds the MAC
 *      check through `timingSafeEqual`.
 *
 * Any one of the three is sufficient. Failures uniformly return
 * 401 + `MissingStaffCapability` so an attacker cannot
 * distinguish "wrong header form" from "expired JWT" from
 * "wrong cookie sig".
 */
const requireStaff = async (c: {
  req: { header: (k: string) => string | undefined }
  env: Env
}): Promise<{ ok: true } | { ok: false; res: Response }> => {
  const secret = c.env.STAFF_SESSION_SECRET
  if (secret === undefined || secret === "") {
    return {
      ok: false,
      res: failResponse(503, "MissingStaffCapability", "E_VAL_MISSING_STAFF_CAPABILITY", {
        reason: "absent",
      }),
    }
  }
  // Header-token path (legacy + curl-friendly).
  const headerToken = c.req.header("x-staff-token")
  if (headerToken !== undefined && timingSafeEqual(headerToken, secret)) {
    return { ok: true }
  }
  // Bearer JWT path.
  const auth = c.req.header("authorization")
  if (auth?.startsWith("Bearer ") === true) {
    const jwt = auth.slice("Bearer ".length).trim()
    if (jwt.length > 0) {
      const result = await verifyStaffJwt(secret, jwt)
      if (result.ok) return { ok: true }
    }
  }
  // Cookie session path.
  const cookieValue = readSessionCookie(c.req.header("cookie"))
  if (cookieValue !== null) {
    const result = await verifySession(secret, cookieValue)
    if (result.ok) return { ok: true }
  }
  // Nothing matched — uniform failure envelope so the surface
  // does not leak which credential shape was attempted.
  return {
    ok: false,
    res: failResponse(401, "MissingStaffCapability", "E_VAL_MISSING_STAFF_CAPABILITY", {
      reason:
        headerToken === undefined && auth === undefined && cookieValue === null
          ? "absent"
          : "wrong_kind",
    }),
  }
}

export const buildQueueApi = (): Hono<{ Bindings: Env }> => {
  const app = new Hono<{ Bindings: Env }>()

  app.use("*", requestLog)
  app.use("*", securityHeaders)
  app.use("*", async (c, next) => {
    const allowed = parseAllowlist(c.env.ALLOWED_ORIGINS)
    const cors = corsAllowlist(c.env.IS_DEV === "1", allowed)
    return cors(c as never, next)
  })

  // Staff login — exchanges the deployment secret for a JWT
  // (response body) + an HMAC-signed cookie session. Bearer +
  // cookie are both honoured by requireStaff.
  app.post("/api/v1/staff/login", (c) => handleStaffLogin(c))

  // Issue is rate-limited per CF-Connecting-IP (60 / min).
  app.post("/api/v1/tickets", rateLimitMiddleware("RL_ISSUE"), async (c) => {
    const raw: unknown = await c.req.json().catch(() => null)
    const decoded = Schema.decodeUnknownResult(IssueTicketBodySchema)(raw)
    if (Result.isFailure(decoded)) return failResponse(422, "InvalidBody", "E_VAL_BODY")
    const handleR = parseCustomerHandleStrict(decoded.success.nameKana, decoded.success.phoneLast4)
    if (Result.isFailure(handleR))
      return failResponse(422, handleR.failure._tag, codeOf(handleR.failure))
    const action: QueueAction = {
      type: "IssueTicket",
      handle: handleR.success,
      freeText: decoded.success.freeText,
    }
    return dispatchEnvelope(await stub(c.env).dispatch(action), 201)
  })

  // GET /api/v1/tickets/me — customer self-fetch (handle in querystring)
  app.get("/api/v1/tickets/me", async (c) => {
    const decoded = Schema.decodeUnknownResult(MyTicketQuerySchema)({
      ticketId: c.req.query("ticketId"),
      nameKana: c.req.query("nameKana"),
      phoneLast4: c.req.query("phoneLast4"),
    })
    if (Result.isFailure(decoded)) return failResponse(422, "InvalidQuery", "E_VAL_QUERY")
    const idR = parseTicketId(decoded.success.ticketId)
    if (Result.isFailure(idR)) return failResponse(404, "TicketNotFound", "E_DOM_TICKET_NOT_FOUND")
    const all = await stub(c.env).listTickets()
    const ticket = all.find((t) => t.id === idR.success)
    if (ticket === undefined) return failResponse(404, "TicketNotFound", "E_DOM_TICKET_NOT_FOUND")
    if (
      ticket.nameKana !== decoded.success.nameKana ||
      ticket.phoneLast4 !== decoded.success.phoneLast4
    ) {
      return failResponse(403, "PhoneMismatch", "E_DOM_PHONE_MISMATCH")
    }
    return new Response(JSON.stringify({ ok: true, ticket }), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    })
  })

  // POST /api/v1/tickets/:id/cancel — staff or customer
  app.post("/api/v1/tickets/:id/cancel", async (c) => {
    const idR = parseTicketId(c.req.param("id"))
    if (Result.isFailure(idR)) return failResponse(404, "TicketNotFound", "E_DOM_TICKET_NOT_FOUND")
    const raw: unknown = await c.req.json().catch(() => null)
    const isStaff = c.req.header("x-staff-token") !== undefined
    if (isStaff) {
      const guard = await requireStaff(c)
      if (!guard.ok) return guard.res
      const decoded = Schema.decodeUnknownResult(StaffCancelBodySchema)(raw)
      if (Result.isFailure(decoded)) return failResponse(422, "InvalidBody", "E_VAL_BODY")
      return dispatchEnvelope(
        await stub(c.env).dispatch({
          type: "CancelTicket",
          ticketId: idR.success,
          actor: "staff",
          reason: decoded.success.reason,
        }),
      )
    }
    const decoded = Schema.decodeUnknownResult(CancelBodySchema)(raw)
    if (Result.isFailure(decoded)) return failResponse(422, "InvalidBody", "E_VAL_BODY")
    const handleR = parseCustomerHandleStrict(decoded.success.nameKana, decoded.success.phoneLast4)
    if (Result.isFailure(handleR))
      return failResponse(422, handleR.failure._tag, codeOf(handleR.failure))
    return dispatchEnvelope(
      await stub(c.env).dispatch({
        type: "CancelTicket",
        ticketId: idR.success,
        actor: "customer",
        reason: decoded.success.reason,
        handle: handleR.success,
      }),
    )
  })

  // GET /api/v1/queue — shop projection (staff sees PII)
  app.get("/api/v1/queue", async (c) => {
    const tickets = await stub(c.env).listTickets()
    const waiting = tickets.filter((t) => t.state === "Waiting").sort((a, b) => a.seq - b.seq)
    const serving = tickets.find((t) => t.state === "Called") ?? null
    const isStaff =
      c.env.STAFF_SESSION_SECRET !== undefined &&
      c.req.header("x-staff-token") === c.env.STAFF_SESSION_SECRET
    if (isStaff) {
      return new Response(
        JSON.stringify({
          ok: true,
          waitingCount: waiting.length,
          serving,
          waitingPreview: waiting.slice(0, 20),
        }),
        { status: 200, headers: { "content-type": "application/json; charset=utf-8" } },
      )
    }
    return new Response(
      JSON.stringify({
        ok: true,
        waitingCount: waiting.length,
        serving: serving === null ? null : { id: serving.id, seq: serving.seq },
        waitingPreview: waiting.slice(0, 10).map((t) => ({ id: t.id, seq: t.seq })),
      }),
      { status: 200, headers: { "content-type": "application/json; charset=utf-8" } },
    )
  })

  // Staff mutations rate-limited per token hash (300 / min).
  app.post("/api/v1/queue/call-next", rateLimitMiddleware("RL_OPERATE"), async (c) => {
    const guard = await requireStaff(c)
    if (!guard.ok) return guard.res
    return dispatchEnvelope(await stub(c.env).dispatch({ type: "CallNext", actor: "staff" }))
  })

  // POST /api/v1/tickets/:id/served — staff
  app.post("/api/v1/tickets/:id/served", async (c) => {
    const guard = await requireStaff(c)
    if (!guard.ok) return guard.res
    const idR = parseTicketId(c.req.param("id"))
    if (Result.isFailure(idR)) return failResponse(404, "TicketNotFound", "E_DOM_TICKET_NOT_FOUND")
    return dispatchEnvelope(
      await stub(c.env).dispatch({ type: "MarkServed", ticketId: idR.success }),
    )
  })

  // POST /api/v1/tickets/:id/no-show — staff
  app.post("/api/v1/tickets/:id/no-show", async (c) => {
    const guard = await requireStaff(c)
    if (!guard.ok) return guard.res
    const idR = parseTicketId(c.req.param("id"))
    if (Result.isFailure(idR)) return failResponse(404, "TicketNotFound", "E_DOM_TICKET_NOT_FOUND")
    return dispatchEnvelope(
      await stub(c.env).dispatch({
        type: "MarkNoShow",
        ticketId: idR.success,
        actor: "staff",
      }),
    )
  })

  // POST /api/v1/tickets/:id/recall — staff
  app.post("/api/v1/tickets/:id/recall", async (c) => {
    const guard = await requireStaff(c)
    if (!guard.ok) return guard.res
    const idR = parseTicketId(c.req.param("id"))
    if (Result.isFailure(idR)) return failResponse(404, "TicketNotFound", "E_DOM_TICKET_NOT_FOUND")
    return dispatchEnvelope(
      await stub(c.env).dispatch({
        type: "Recall",
        ticketId: idR.success,
        actor: "staff",
      }),
    )
  })

  // GET /api/v1/openapi.json — OpenAPI 3.1 document
  app.get("/api/v1/openapi.json", (_c) => {
    return new Response(JSON.stringify(openApiDocument), {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "public, max-age=300",
      },
    })
  })

  // GET /api/v1/queue/feed — DO Hibernating WebSocket projection
  // feed. Replaces the 2 s SSE polling loop with a server-push
  // stream the QueueShop DO emits on every successful dispatch.
  // The router forwards the upgrade unchanged; the DO's `fetch`
  // handles the `Upgrade: websocket` exchange + acceptWebSocket so
  // the actor can hibernate between events without dropping live
  // connections (ADR-0061).
  app.get("/api/v1/queue/feed", (c) => {
    if (c.req.header("upgrade") !== "websocket") {
      return c.text("Expected websocket upgrade", 426)
    }
    const id = c.env.QUEUE_SHOP.idFromName("shop")
    const obj = c.env.QUEUE_SHOP.get(id)
    return obj.fetch(c.req.raw)
  })

  return app
}
