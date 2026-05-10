import { Result, Schema } from "effect"
import { Hono } from "hono"
import type { QueueAction, QueueResult, QueueShop } from "../durableObjects/QueueShop.js"
import { verifyStaffJwt } from "../security/jwt.js"
import { readSessionCookie, verifySession } from "../security/session.js"
import { timingSafeEqual } from "../security/timingSafeEqual.js"
import { handleStaffLogin } from "./auth/login.js"
import {
  CallBatchBodySchema,
  CallNextBodySchema,
  CallSpecificBodySchema,
  CancelBodySchema,
  decodeTicketIdParam,
  dispatchDecodeFailure,
  IssueTicketBodySchema,
  MyTicketQuerySchema,
  ReorderBodySchema,
  StaffCancelBodySchema,
} from "./boundarySchemas.js"
import { envelopeLog } from "./envelopeLog.js"
import { DEFECT_STATUS, statusForTag } from "./errorEnvelope.js"
import { onError } from "./onError.js"
import { openApiDocument } from "./openapi.js"
import { parseJsonBody } from "./parseJsonBody.js"
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
 *   POST  /tickets                       issue (body lane? — ADR-0062)
 *   GET   /tickets/me                    customer self-fetch
 *   POST  /tickets/:id/cancel            cancel (customer with handle, or staff)
 *   POST  /tickets/:id/served            staff: mark served (Called | Serving)
 *   POST  /tickets/:id/no-show           staff: mark no-show (Called only)
 *   POST  /tickets/:id/recall            staff: recall (Called -> Waiting)
 *   POST  /tickets/:id/start-serving     staff: Called -> Serving (ADR-0063)
 *   GET   /queue                         shop state v2 (calling[]/serving[],
 *                                        PII for staff, anon otherwise)
 *   POST  /queue/call-next               staff: call next (body lane?)
 *   POST  /queue/call-specific           staff: call a specific Waiting (ADR-0065)
 *   POST  /queue/call-batch               staff: atomic batch call (ADR-0065)
 *   POST  /queue/reorder                 staff: reorder within lane (ADR-0065)
 *   GET   /queue/feed                    DO Hibernating WebSocket projection feed (v2)
 */

const stub = (env: Env): DurableObjectStub<QueueShop> =>
  env.QUEUE_SHOP.get(env.QUEUE_SHOP.idFromName("shop"))

const dispatchEnvelope = (result: QueueResult, status = 200): Response => {
  if (result.ok) {
    const body =
      "tickets" in result
        ? { ok: true, tickets: result.tickets }
        : { ok: true, ticket: result.ticket }
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    })
  }
  return new Response(
    JSON.stringify({
      ok: false,
      error: { _tag: result.error._tag, code: result.error.code },
    }),
    {
      status:
        result.error._tag === "Defect" ? DEFECT_STATUS : statusForTag(result.error._tag as never),
      headers: { "content-type": "application/json; charset=utf-8" },
    },
  )
}

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
  app.use("*", envelopeLog)
  app.onError(onError)

  // Staff login — exchanges the deployment secret for a JWT
  // (response body) + an HMAC-signed cookie session. Bearer +
  // cookie are both honoured by requireStaff.
  app.post("/api/v1/staff/login", (c) => handleStaffLogin(c))

  // Issue is rate-limited per CF-Connecting-IP (60 / min).
  app.post("/api/v1/tickets", rateLimitMiddleware("RL_ISSUE"), async (c) => {
    const parsed = await parseJsonBody(c)
    if (!parsed.ok) {
      return failResponse(parsed.status, parsed.tag, parsed.code, { reason: parsed.reason })
    }
    const decoded = Schema.decodeUnknownResult(IssueTicketBodySchema)(parsed.raw)
    if (Result.isFailure(decoded)) {
      const fail = dispatchDecodeFailure(decoded.failure)
      return failResponse(fail.status, fail.tag, fail.code)
    }
    const action: QueueAction = {
      type: "IssueTicket",
      handle: {
        nameKana: decoded.success.nameKana,
        phoneLast4: decoded.success.phoneLast4,
      },
      freeText: decoded.success.freeText,
      ...(decoded.success.lane !== undefined ? { lane: decoded.success.lane } : {}),
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
    if (Result.isFailure(decoded)) {
      const fail = dispatchDecodeFailure(decoded.failure)
      return failResponse(fail.status, fail.tag, fail.code)
    }
    const all = await stub(c.env).listTickets()
    const ticket = all.find((t) => t.id === decoded.success.ticketId)
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

  // POST /api/v1/tickets/:id/cancel — staff or customer. Body parse
  // must run **before** the path-param TicketId decode so a
  // malformed body surfaces as a distinct 400 InvalidPayload (C7);
  // id-shape failures fall through to the standard 404 TicketNotFound.
  app.post("/api/v1/tickets/:id/cancel", async (c) => {
    const parsed = await parseJsonBody(c)
    if (!parsed.ok) {
      return failResponse(parsed.status, parsed.tag, parsed.code, { reason: parsed.reason })
    }
    const idR = decodeTicketIdParam(c.req.param("id"))
    if (Result.isFailure(idR)) return failResponse(404, "TicketNotFound", "E_DOM_TICKET_NOT_FOUND")
    const raw = parsed.raw
    const isStaff = c.req.header("x-staff-token") !== undefined
    if (isStaff) {
      const guard = await requireStaff(c)
      if (!guard.ok) return guard.res
      const decoded = Schema.decodeUnknownResult(StaffCancelBodySchema)(raw)
      if (Result.isFailure(decoded)) {
        const fail = dispatchDecodeFailure(decoded.failure)
        return failResponse(fail.status, fail.tag, fail.code)
      }
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
    if (Result.isFailure(decoded)) {
      const fail = dispatchDecodeFailure(decoded.failure)
      return failResponse(fail.status, fail.tag, fail.code)
    }
    return dispatchEnvelope(
      await stub(c.env).dispatch({
        type: "CancelTicket",
        ticketId: idR.success,
        actor: "customer",
        reason: decoded.success.reason,
        handle: {
          nameKana: decoded.success.nameKana,
          phoneLast4: decoded.success.phoneLast4,
        },
      }),
    )
  })

  // GET /api/v1/queue — shop projection v2 (ADR-0062 / 0063 / 0065).
  // Anonymous payload exposes lane / displaySeq + calling[] +
  // serving[] arrays; staff payload carries the full ticket rows
  // (PII inclusive).
  app.get("/api/v1/queue", async (c) => {
    const tickets = await stub(c.env).listTickets()
    const waiting = tickets
      .filter((t) => t.state === "Waiting")
      .sort((a, b) => a.displaySeq - b.displaySeq)
    const calling = tickets
      .filter((t) => t.state === "Called")
      .sort((a, b) => a.displaySeq - b.displaySeq)
    const serving = tickets
      .filter((t) => t.state === "Serving")
      .sort((a, b) => a.displaySeq - b.displaySeq)
    const project = (t: (typeof tickets)[number]) => ({
      id: t.id,
      seq: t.seq,
      lane: t.lane,
      displaySeq: t.displaySeq,
    })
    const laneCount = (lane: "walkIn" | "priority" | "reservation") =>
      waiting.filter((t) => t.lane === lane).length
    const isStaff =
      c.env.STAFF_SESSION_SECRET !== undefined &&
      c.req.header("x-staff-token") === c.env.STAFF_SESSION_SECRET
    if (isStaff) {
      return new Response(
        JSON.stringify({
          ok: true,
          v: 2,
          waitingCount: waiting.length,
          laneCounts: {
            walkIn: laneCount("walkIn"),
            priority: laneCount("priority"),
            reservation: laneCount("reservation"),
          },
          calling,
          serving,
          waitingPreview: waiting.slice(0, 20),
        }),
        { status: 200, headers: { "content-type": "application/json; charset=utf-8" } },
      )
    }
    return new Response(
      JSON.stringify({
        ok: true,
        v: 2,
        waitingCount: waiting.length,
        laneCounts: {
          walkIn: laneCount("walkIn"),
          priority: laneCount("priority"),
          reservation: laneCount("reservation"),
        },
        calling: calling.map(project),
        serving: serving.map(project),
        waitingPreview: waiting.slice(0, 10).map(project),
      }),
      { status: 200, headers: { "content-type": "application/json; charset=utf-8" } },
    )
  })

  // POST /api/v1/queue/call-next — staff. Body `{ lane? }` chooses
  // a specific lane head; an empty body means "preferred-lane chain
  // default" (ADR-0062). Rate-limited per token hash (300 / min).
  app.post("/api/v1/queue/call-next", rateLimitMiddleware("RL_OPERATE"), async (c) => {
    const guard = await requireStaff(c)
    if (!guard.ok) return guard.res
    let raw: unknown = {}
    try {
      const text = await c.req.text()
      if (text.length > 0) raw = JSON.parse(text) as unknown
    } catch (err) {
      return failResponse(400, "InvalidPayload", "E_VAL_PAYLOAD", {
        reason: err instanceof Error ? err.message : "non-json body",
      })
    }
    const decoded = Schema.decodeUnknownResult(CallNextBodySchema)(raw)
    if (Result.isFailure(decoded)) {
      const fail = dispatchDecodeFailure(decoded.failure)
      return failResponse(fail.status, fail.tag, fail.code)
    }
    const action: QueueAction = {
      type: "CallNext",
      actor: "staff",
      ...(decoded.success.lane !== undefined ? { lane: decoded.success.lane } : {}),
    }
    return dispatchEnvelope(await stub(c.env).dispatch(action))
  })

  // POST /api/v1/queue/call-specific — staff. Body `{ ticketId }`
  // (ADR-0065).
  app.post("/api/v1/queue/call-specific", rateLimitMiddleware("RL_OPERATE"), async (c) => {
    const guard = await requireStaff(c)
    if (!guard.ok) return guard.res
    const parsed = await parseJsonBody(c)
    if (!parsed.ok) {
      return failResponse(parsed.status, parsed.tag, parsed.code, { reason: parsed.reason })
    }
    const decoded = Schema.decodeUnknownResult(CallSpecificBodySchema)(parsed.raw)
    if (Result.isFailure(decoded)) {
      const fail = dispatchDecodeFailure(decoded.failure)
      return failResponse(fail.status, fail.tag, fail.code)
    }
    return dispatchEnvelope(
      await stub(c.env).dispatch({
        type: "CallSpecific",
        ticketId: decoded.success.ticketId,
        actor: "staff",
      }),
    )
  })

  // POST /api/v1/queue/call-batch — staff. Body
  // `{ ticketIds: NonEmpty<TicketId> }` (ADR-0065). Atomic batch:
  // any per-member failure rolls every member back; the response
  // carries `tickets[]` (every member that landed Called).
  app.post("/api/v1/queue/call-batch", rateLimitMiddleware("RL_OPERATE"), async (c) => {
    const guard = await requireStaff(c)
    if (!guard.ok) return guard.res
    const parsed = await parseJsonBody(c)
    if (!parsed.ok) {
      return failResponse(parsed.status, parsed.tag, parsed.code, { reason: parsed.reason })
    }
    const decoded = Schema.decodeUnknownResult(CallBatchBodySchema)(parsed.raw)
    if (Result.isFailure(decoded)) {
      const fail = dispatchDecodeFailure(decoded.failure)
      return failResponse(fail.status, fail.tag, fail.code)
    }
    const ids = decoded.success.ticketIds
    const head = ids[0]
    /* v8 ignore next 3 */
    if (head === undefined) {
      return failResponse(422, "InvalidBody", "E_VAL_BODY")
    }
    return dispatchEnvelope(
      await stub(c.env).dispatch({
        type: "CallBatch",
        ticketIds: [head, ...ids.slice(1)] as const,
        actor: "staff",
      }),
    )
  })

  // POST /api/v1/queue/reorder — staff. Body
  // `{ ticketId, afterTicketId: TicketId | null }` (ADR-0065). Lane
  // mismatch surfaces 409 LaneMismatch.
  app.post("/api/v1/queue/reorder", rateLimitMiddleware("RL_OPERATE"), async (c) => {
    const guard = await requireStaff(c)
    if (!guard.ok) return guard.res
    const parsed = await parseJsonBody(c)
    if (!parsed.ok) {
      return failResponse(parsed.status, parsed.tag, parsed.code, { reason: parsed.reason })
    }
    const decoded = Schema.decodeUnknownResult(ReorderBodySchema)(parsed.raw)
    if (Result.isFailure(decoded)) {
      const fail = dispatchDecodeFailure(decoded.failure)
      return failResponse(fail.status, fail.tag, fail.code)
    }
    return dispatchEnvelope(
      await stub(c.env).dispatch({
        type: "Reorder",
        ticketId: decoded.success.ticketId,
        afterTicketId: decoded.success.afterTicketId,
        actor: "staff",
      }),
    )
  })

  // POST /api/v1/tickets/:id/start-serving — staff (ADR-0063).
  app.post("/api/v1/tickets/:id/start-serving", rateLimitMiddleware("RL_OPERATE"), async (c) => {
    const guard = await requireStaff(c)
    if (!guard.ok) return guard.res
    const idR = decodeTicketIdParam(c.req.param("id"))
    if (Result.isFailure(idR)) return failResponse(404, "TicketNotFound", "E_DOM_TICKET_NOT_FOUND")
    return dispatchEnvelope(
      await stub(c.env).dispatch({
        type: "StartServing",
        ticketId: idR.success,
        actor: "staff",
      }),
    )
  })

  // POST /api/v1/tickets/:id/served — staff
  app.post("/api/v1/tickets/:id/served", async (c) => {
    const guard = await requireStaff(c)
    if (!guard.ok) return guard.res
    const idR = decodeTicketIdParam(c.req.param("id"))
    if (Result.isFailure(idR)) return failResponse(404, "TicketNotFound", "E_DOM_TICKET_NOT_FOUND")
    return dispatchEnvelope(
      await stub(c.env).dispatch({ type: "MarkServed", ticketId: idR.success }),
    )
  })

  // POST /api/v1/tickets/:id/no-show — staff
  app.post("/api/v1/tickets/:id/no-show", async (c) => {
    const guard = await requireStaff(c)
    if (!guard.ok) return guard.res
    const idR = decodeTicketIdParam(c.req.param("id"))
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
    const idR = decodeTicketIdParam(c.req.param("id"))
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
