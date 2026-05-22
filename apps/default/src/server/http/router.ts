import {
  BusinessTimeZoneSchema,
  constantTimeStringEqual,
  intervalOf,
  reservationsByDeadline,
  type Slot,
  TicketSchema,
} from "@booking/core"
import { Result, Schema } from "effect"
import { Hono } from "hono"
import type { QueueAction, QueueResult, QueueShop } from "../durableObjects/QueueShop.js"
import { verifyStaffJwt } from "../security/jwt.js"
import { readSessionCookie, verifySession } from "../security/session.js"
import { timingSafeEqual } from "../security/timingSafeEqual.js"
import { handleStaffLogin } from "./auth/login.js"
import {
  ByHandleQuerySchema,
  CallBatchBodySchema,
  CallNextBodySchema,
  CallSpecificBodySchema,
  CancelBodySchema,
  decodeTicketIdParam,
  dispatchDecodeFailure,
  IssueTicketBodySchema,
  MyTicketQuerySchema,
  PushSubscriptionBodySchema,
  PushSubscriptionDeleteQuerySchema,
  RescheduleBodySchema,
  SlotsQuerySchema,
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
 *   POST  /tickets                                issue (body lane? — ADR-0062)
 *   GET   /tickets/me                             customer self-fetch
 *   GET   /tickets/by-handle                      customer recovery (ADR-0069)
 *   POST  /tickets/:id/cancel                     cancel (customer with handle, or staff)
 *   POST  /tickets/:id/check-in                   customer arrival audit (ADR-0068)
 *   POST  /tickets/:id/reschedule                 atomic appointmentAt swap (ADR-0070)
 *   POST  /tickets/:id/served                     staff: mark served (Called | Overdue — ADR-0071)
 *   POST  /tickets/:id/no-show                    staff: mark no-show (Called | Overdue — ADR-0072)
 *   POST  /tickets/:id/recall                     staff: recall (Called | Overdue -> Waiting)
 *   POST  /tickets/:id/push-subscription          customer registers Web Push subscription (ADR-0073)
 *   DELETE /tickets/:id/push-subscription         customer unsubscribe (ADR-0074)
 *   GET   /queue                                  shop projection v4 (calling[] / overdue[] — ADR-0071/0072)
 *   POST  /queue/call-next                        staff: call next (body lane?)
 *   POST  /queue/call-specific                    staff: call a specific Waiting (ADR-0065)
 *   POST  /queue/call-batch                       staff: atomic batch call (ADR-0065)
 *   GET   /queue/feed                             DO Hibernating WebSocket projection feed (ADR-0061)
 */

const stub = (env: Env): DurableObjectStub<QueueShop> =>
  env.QUEUE_SHOP.get(env.QUEUE_SHOP.idFromName("shop"))

/**
 * ADR-0073 / ADR-0074 — gate `POST .../push-subscription` to the
 * three real push-service origins so a stray identifier cannot be
 * smuggled into the subscription table. The list is the union of
 * what FCM (Chrome / Edge / Brave), Mozilla Push, and Apple Web
 * Push expose. New origins join only via this allowlist + an ADR
 * note.
 */
const ALLOWED_PUSH_ENDPOINT_HOSTS: ReadonlySet<string> = new Set([
  "fcm.googleapis.com",
  "updates.push.services.mozilla.com",
  "web.push.apple.com",
])

const isAllowedPushEndpoint = (endpoint: string): boolean => {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return false
  }
  if (url.protocol !== "https:") return false
  return ALLOWED_PUSH_ENDPOINT_HOSTS.has(url.host)
}

const dispatchEnvelope = (result: QueueResult, status = 200): Response => {
  if (result.ok) {
    const body =
      "tickets" in result
        ? { ok: true, tickets: result.tickets }
        : "ticket" in result
          ? {
              ok: true,
              ticket: result.ticket,
              ...(result.merged === true ? { merged: true } : {}),
            }
          : { ok: true }
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
      // String-encode at the wire — the DO RPC boundary serialises
      // every arg through structuredClone, which rejects
      // Temporal.Instant. The DO dispatch decodes via core's
      // InstantSchema before handing off to the use case.
      ...(decoded.success.appointmentAt !== undefined
        ? { appointmentAt: String(decoded.success.appointmentAt) }
        : {}),
    }
    // ADR-0069: idempotent merge surfaces as 200 OK; a fresh issue
    // remains 201 Created. The body carries `merged: true` on the
    // merged variant so the web client can show "this is your
    // existing ticket" rather than a fresh-issue label.
    const result = await stub(c.env).dispatch(action)
    const merged = result.ok && "ticket" in result && result.merged === true
    return dispatchEnvelope(result, merged ? 200 : 201)
  })

  // GET /api/v1/tickets/me — customer self-fetch (handle in querystring).
  // Rate-limited per CF-Connecting-IP (RL_VERIFY, 30 / min) to slow
  // (kana, last4) brute force on a known ticketId — see ADR-0058.
  app.get("/api/v1/tickets/me", rateLimitMiddleware("RL_VERIFY"), async (c) => {
    const decoded = Schema.decodeUnknownResult(MyTicketQuerySchema)({
      ticketId: c.req.query("ticketId"),
      nameKana: c.req.query("nameKana"),
      phoneLast4: c.req.query("phoneLast4"),
    })
    if (Result.isFailure(decoded)) {
      const fail = dispatchDecodeFailure(decoded.failure)
      return failResponse(fail.status, fail.tag, fail.code)
    }
    // Direct primary-key lookup (O(log N) on the SQLite btree)
    // — the previous `listTickets()` + `Array.find` was O(N) JSON-
    // decode per request, which doubled as a DoS lever for an
    // attacker probing /tickets/me at the RL_VERIFY ceiling.
    const ticket = await stub(c.env).getTicketById(decoded.success.ticketId)
    if (ticket === null) return failResponse(404, "TicketNotFound", "E_DOM_TICKET_NOT_FOUND")
    // Constant-time compare on both components (CWE-208). Without
    // this an attacker who knows the ticketId can narrow the
    // (kana, last4) pair via response-timing differential between
    // "kana wrong" (short-circuit on first byte) and "kana right +
    // last4 wrong" (full kana scan + last4 check). Both checks
    // always run before the post-evaluation `||` so the response-
    // time signal does not distinguish which component failed.
    const kanaOK = constantTimeStringEqual(ticket.nameKana, decoded.success.nameKana)
    const phoneOK = constantTimeStringEqual(ticket.phoneLast4, decoded.success.phoneLast4)
    if (!kanaOK || !phoneOK) {
      return failResponse(403, "PhoneMismatch", "E_DOM_PHONE_MISMATCH")
    }
    return new Response(JSON.stringify({ ok: true, ticket }), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    })
  })

  // GET /api/v1/tickets/by-handle?k&p — customer recovery primitive
  // (ADR-0069). The handle is the active-set primary key, so a 200
  // response carries the single active ticket for the supplied
  // (nameKana, phoneLast4); 404 means "no active ticket". Same
  // RL_VERIFY ceiling as /tickets/me, mitigating the (kana × last4)
  // enumeration oracle.
  app.get("/api/v1/tickets/by-handle", rateLimitMiddleware("RL_VERIFY"), async (c) => {
    const decoded = Schema.decodeUnknownResult(ByHandleQuerySchema)({
      nameKana: c.req.query("nameKana"),
      phoneLast4: c.req.query("phoneLast4"),
    })
    if (Result.isFailure(decoded)) {
      const fail = dispatchDecodeFailure(decoded.failure)
      return failResponse(fail.status, fail.tag, fail.code)
    }
    const ticket = await stub(c.env).getByHandle(decoded.success)
    if (ticket === null) return failResponse(404, "TicketNotFound", "E_DOM_TICKET_NOT_FOUND")
    return new Response(JSON.stringify({ ok: true, ticket }), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    })
  })

  // POST /api/v1/tickets/:id/check-in — customer-side arrival audit
  // for reservation tickets (ADR-0068). The CheckIn use case gates
  // on Waiting+reservation+within-window; the void return surfaces
  // as `{ ok: true }` (no `ticket` field) on the wire.
  app.post("/api/v1/tickets/:id/check-in", rateLimitMiddleware("RL_VERIFY"), async (c) => {
    const idR = decodeTicketIdParam(c.req.param("id"))
    if (Result.isFailure(idR)) return failResponse(404, "TicketNotFound", "E_DOM_TICKET_NOT_FOUND")
    return dispatchEnvelope(await stub(c.env).dispatch({ type: "CheckIn", ticketId: idR.success }))
  })

  // POST /api/v1/tickets/:id/reschedule — atomic appointmentAt swap
  // (ADR-0070). Customer path (handle in body) or staff path (token
  // via x-staff-token). The new slot's capacity is checked excluding
  // the ticket itself so a same-slot reschedule is a no-op success.
  app.post("/api/v1/tickets/:id/reschedule", rateLimitMiddleware("RL_VERIFY"), async (c) => {
    const idR = decodeTicketIdParam(c.req.param("id"))
    if (Result.isFailure(idR)) return failResponse(404, "TicketNotFound", "E_DOM_TICKET_NOT_FOUND")
    const parsed = await parseJsonBody(c)
    if (!parsed.ok)
      return failResponse(parsed.status, parsed.tag, parsed.code, { reason: parsed.reason })
    const decoded = Schema.decodeUnknownResult(RescheduleBodySchema)(parsed.raw)
    if (Result.isFailure(decoded)) {
      const fail = dispatchDecodeFailure(decoded.failure)
      return failResponse(fail.status, fail.tag, fail.code)
    }
    const isStaff =
      c.env.STAFF_SESSION_SECRET !== undefined &&
      c.req.header("x-staff-token") === c.env.STAFF_SESSION_SECRET
    // NaN-safe coercion: `Number("")` and `Number("abc")` both yield
    // NaN. Without the `|| <default>` arm a NaN capacity would slip
    // past every comparison and accept every booking, and a NaN
    // granularity would corrupt `bucketOf`.
    const granularity = (Number(c.env.SLOT_DEFAULT_GRANULARITY) || 30) as 15 | 30 | 60
    // Defensive default: the wrangler binding ships "Asia/Tokyo" by
    // default; this fallback covers the (unlikely) misconfigured
    // deploy that strips the binding. Without the fallback the
    // reschedule path would crash on the slot computation; with it
    // the customer's clock continues to make sense.
    const tz = c.env.DEPLOYMENT_TIMEZONE ?? "Asia/Tokyo"
    const capacity = Number(c.env.SLOT_DEFAULT_CAPACITY) || 2
    const handle =
      !isStaff && decoded.success.nameKana !== undefined && decoded.success.phoneLast4 !== undefined
        ? {
            nameKana: decoded.success.nameKana,
            phoneLast4: decoded.success.phoneLast4,
          }
        : undefined
    if (!isStaff && handle === undefined) {
      return failResponse(422, "InvalidBody", "E_VAL_BODY")
    }
    return dispatchEnvelope(
      await stub(c.env).dispatch({
        type: "RescheduleTicket",
        ticketId: idR.success,
        newAppointmentAt: decoded.success.newAppointmentAt,
        granularity,
        tz,
        capacity,
        actor: isStaff ? "staff" : "customer",
        ...(handle !== undefined ? { handle } : {}),
      }),
    )
  })

  // GET /api/v1/slots — bucket-grid availability for the customer's
  // /book picker (ADR-0066 / ADR-0068). Returns one row per bucket
  // in the [from, to] window, with `taken` derived from the live
  // reservation lane count and `capacity` from
  // SLOT_DEFAULT_CAPACITY env (default 2). Does NOT consult the
  // (optional) per-bucket `slots` override table — adding that lookup
  // is a follow-on for shops that need per-bucket overrides.
  app.get("/api/v1/slots", async (c) => {
    const decoded = Schema.decodeUnknownResult(SlotsQuerySchema)({
      from: c.req.query("from"),
      to: c.req.query("to"),
      granularity: Number(c.req.query("granularity")),
    })
    if (Result.isFailure(decoded)) {
      const fail = dispatchDecodeFailure(decoded.failure)
      return failResponse(fail.status, fail.tag, fail.code)
    }
    const { from, to, granularity } = decoded.success
    // NaN-safe — empty string or non-numeric env value falls back
    // to the canonical default (2 per shop bucket).
    const capacity = Number(c.env.SLOT_DEFAULT_CAPACITY) || 2
    // The bucket→instant projection lives in the business time zone
    // (ADR-0066 §morphism); a JST deployment computes 09:00 buckets
    // at JST 09:00 = 00:00 UTC, not 09:00 UTC. `intervalOf` is the
    // canonical morphism — using it here means the slot endpoint
    // matches `slotOccupancy`'s aggregation path inside the DO.
    const tz = Schema.decodeUnknownSync(BusinessTimeZoneSchema)(
      c.env.DEPLOYMENT_TIMEZONE ?? "Asia/Tokyo",
    )
    const all = await stub(c.env).listTickets()
    const reservations = all.filter(
      (t) =>
        t.lane === "reservation" &&
        t.appointmentAt !== null &&
        (t.state === "Waiting" || t.state === "Called" || t.state === "Overdue"),
    )
    const reservationStartMs = reservations.map((t) =>
      t.appointmentAt !== null ? Date.parse(t.appointmentAt) : Number.NaN,
    )
    const result: {
      readonly date: string
      readonly bucketId: number
      readonly granularity: number
      readonly capacity: number
      readonly taken: number
      readonly available: number
    }[] = []
    let cursor = from
    while (cursor.toString() <= to.toString()) {
      for (let b = 0; b * granularity < 24 * 60; b += 1) {
        const slot: Slot = {
          date: cursor,
          bucketId: b as never,
          granularity,
          capacity,
        }
        const slotStartMs = intervalOf(slot, tz).startAt.epochMilliseconds
        let taken = 0
        for (const ms of reservationStartMs) {
          if (ms === slotStartMs) taken += 1
        }
        result.push({
          date: cursor.toString(),
          bucketId: b,
          granularity,
          capacity,
          taken,
          available: Math.max(0, capacity - taken),
        })
      }
      cursor = cursor.add({ days: 1 })
    }
    return new Response(JSON.stringify({ ok: true, slots: result }), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    })
  })

  // POST /api/v1/tickets/:id/cancel — staff or customer. Body parse
  // must run **before** the path-param TicketId decode so a
  // malformed body surfaces as a distinct 400 InvalidPayload (C7);
  // id-shape failures fall through to the standard 404 TicketNotFound.
  // Rate-limited per IP for the customer path (the staff cookie / JWT
  // route falls back to RL_OPERATE — applied below after the actor
  // is identified).
  app.post("/api/v1/tickets/:id/cancel", rateLimitMiddleware("RL_VERIFY"), async (c) => {
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

  // GET /api/v1/queue — shop projection v4 (ADR-0062 / 0065 /
  // 0066 / 0067 / 0071 / 0072). Anonymous payload exposes lane /
  // displaySeq / appointmentAt + calling[] + overdue[] arrays;
  // staff payload carries the full ticket rows (PII inclusive).
  // `nextReservationDeadline` mirrors the WS broadcast field so
  // initial-load and live-update paths converge on the same shape.
  app.get("/api/v1/queue", async (c) => {
    const tickets = await stub(c.env).listTickets()
    const waiting = tickets
      .filter((t) => t.state === "Waiting")
      .sort((a, b) => a.displaySeq - b.displaySeq)
    const calling = tickets
      .filter((t) => t.state === "Called")
      .sort((a, b) => a.displaySeq - b.displaySeq)
    const overdue = tickets
      .filter((t) => t.state === "Overdue")
      .sort((a, b) => a.displaySeq - b.displaySeq)
    // ADR-0069 §Stage 11 — staff 履歴 column needs the recent terminal
    // tickets so an operator can see what just finished. `seq` is
    // monotone over the queue's lifetime, so sorting desc + slicing 8
    // gives a stable "newest first" recency proxy without a time
    // index. Anonymous projection does not include this slice (no
    // benefit to the public landing, plus PII via seq position).
    const terminalRecent = tickets
      .filter((t) => t.state === "Served" || t.state === "Cancelled" || t.state === "NoShow")
      .sort((a, b) => b.seq - a.seq)
      .slice(0, 8)
    const project = (t: (typeof tickets)[number]) => ({
      id: t.id,
      seq: t.seq,
      lane: t.lane,
      displaySeq: t.displaySeq,
      appointmentAt: t.appointmentAt,
    })
    const laneCount = (lane: "walkIn" | "reservation") =>
      waiting.filter((t) => t.lane === lane).length
    // Compute the EDF next-deadline from the encoded snapshot. The
    // helper expects decoded Tickets, so we round-trip via Schema.
    const decodedWaiting = waiting.map((w) => Schema.decodeUnknownSync(TicketSchema)(w))
    const decodedMap = new Map(decodedWaiting.map((t) => [t.id, t] as const))
    const ranked = reservationsByDeadline({ tickets: decodedMap })
    const nextReservationDeadline =
      ranked[0]?.appointmentAt !== null && ranked[0]?.appointmentAt !== undefined
        ? String(ranked[0].appointmentAt)
        : null
    // Three-way: no header → public projection; header present but
    // invalid → 403 (was: silently degrade to public, which left the
    // client deserializing anonymous shape into staff-typed state and
    // crashing on `terminal: undefined` / `nameKana: undefined`); header
    // present and valid via timing-safe compare → staff projection.
    const headerToken = c.req.header("x-staff-token")
    if (headerToken !== undefined && headerToken !== "") {
      if (
        c.env.STAFF_SESSION_SECRET === undefined ||
        !timingSafeEqual(headerToken, c.env.STAFF_SESSION_SECRET)
      ) {
        return failResponse(403, "MissingStaffCapability", "E_VAL_MISSING_STAFF_CAPABILITY", {
          reason: "invalid-staff-token",
        })
      }
      return new Response(
        JSON.stringify({
          ok: true,
          v: 4,
          waitingCount: waiting.length,
          laneCounts: {
            walkIn: laneCount("walkIn"),
            reservation: laneCount("reservation"),
          },
          calling,
          overdue,
          waitingPreview: waiting.slice(0, 20),
          terminal: terminalRecent,
          nextReservationDeadline,
        }),
        { status: 200, headers: { "content-type": "application/json; charset=utf-8" } },
      )
    }
    return new Response(
      JSON.stringify({
        ok: true,
        v: 4,
        waitingCount: waiting.length,
        laneCounts: {
          walkIn: laneCount("walkIn"),
          reservation: laneCount("reservation"),
        },
        calling: calling.map(project),
        overdue: overdue.map(project),
        waitingPreview: waiting.slice(0, 10).map(project),
        nextReservationDeadline,
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
      if (text.length > 0) raw = JSON.parse(text)
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

  // POST /api/v1/tickets/:id/push-subscription — customer registers
  // a Web Push subscription for the ticket. Customer-authenticated:
  // body carries `(nameKana, phoneLast4)` which the DO compares
  // constant-time against the ticket's stored handle (cancel-pattern
  // parity, ADR-0058 / ADR-0074). The endpoint origin is validated
  // against the known push-service hosts (ADR-0073) so a stray
  // identifier cannot be smuggled into the row store.
  app.post("/api/v1/tickets/:id/push-subscription", rateLimitMiddleware("RL_VERIFY"), async (c) => {
    const idR = decodeTicketIdParam(c.req.param("id"))
    if (Result.isFailure(idR)) return failResponse(404, "TicketNotFound", "E_DOM_TICKET_NOT_FOUND")
    const parsed = await parseJsonBody(c)
    if (!parsed.ok) {
      return failResponse(parsed.status, parsed.tag, parsed.code, { reason: parsed.reason })
    }
    const decoded = Schema.decodeUnknownResult(PushSubscriptionBodySchema)(parsed.raw)
    if (Result.isFailure(decoded)) {
      const fail = dispatchDecodeFailure(decoded.failure)
      return failResponse(fail.status, fail.tag, fail.code)
    }
    if (!isAllowedPushEndpoint(decoded.success.endpoint)) {
      return failResponse(422, "InvalidPushEndpoint", "E_VAL_PUSH_ENDPOINT")
    }
    const r = await stub(c.env).registerPushSubscription(
      idR.success,
      { nameKana: decoded.success.nameKana, phoneLast4: decoded.success.phoneLast4 },
      {
        endpoint: decoded.success.endpoint,
        p256dh: decoded.success.p256dh,
        auth: decoded.success.auth,
      },
    )
    if (!r.ok) {
      const status = r.reason === "TicketNotFound" ? 404 : r.reason === "PhoneMismatch" ? 403 : 409
      const code =
        r.reason === "PhoneMismatch" ? "E_DOM_PHONE_MISMATCH" : `E_${r.reason.toUpperCase()}`
      return failResponse(status, r.reason, code)
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 201,
      headers: { "content-type": "application/json; charset=utf-8" },
    })
  })

  // DELETE /api/v1/tickets/:id/push-subscription?nameKana=…&phoneLast4=…&endpoint=… —
  // customer-initiated unsubscribe. Customer-authenticated via query
  // string (DELETE body is non-portable). Idempotent; missing row →
  // 200 OK.
  app.delete(
    "/api/v1/tickets/:id/push-subscription",
    rateLimitMiddleware("RL_VERIFY"),
    async (c) => {
      const idR = decodeTicketIdParam(c.req.param("id"))
      if (Result.isFailure(idR))
        return failResponse(404, "TicketNotFound", "E_DOM_TICKET_NOT_FOUND")
      const params = new URL(c.req.url).searchParams
      const decoded = Schema.decodeUnknownResult(PushSubscriptionDeleteQuerySchema)({
        nameKana: params.get("nameKana") ?? "",
        phoneLast4: params.get("phoneLast4") ?? "",
        endpoint: params.get("endpoint") ?? "",
      })
      if (Result.isFailure(decoded)) {
        const fail = dispatchDecodeFailure(decoded.failure)
        return failResponse(fail.status, fail.tag, fail.code)
      }
      const r = await stub(c.env).unregisterPushSubscription(
        idR.success,
        { nameKana: decoded.success.nameKana, phoneLast4: decoded.success.phoneLast4 },
        decoded.success.endpoint,
      )
      if (!r.ok) {
        const status = r.reason === "PhoneMismatch" ? 403 : 409
        const code =
          r.reason === "PhoneMismatch" ? "E_DOM_PHONE_MISMATCH" : `E_${r.reason.toUpperCase()}`
        return failResponse(status, r.reason, code)
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      })
    },
  )

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
