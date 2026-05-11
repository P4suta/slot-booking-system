/**
 * Declarative endpoint table (S16 / ADR-0084).
 *
 * The single source of truth for every `/api/v1/*` route the
 * server publishes. `router.ts` walks this list through
 * `registerRoutes(app, ROUTES)` so the HTTP surface stays a
 * value, not a side-effecting `app.get(...).post(...)` script.
 *
 * Each entry is a {@link RouteDescriptor}:
 *
 *   - `method`     — `"GET" | "POST"`
 *   - `path`       — Hono path template, e.g. `"/api/v1/tickets/:id"`
 *   - `rateLimit?` — optional namespace forwarded to
 *                    `rateLimitMiddleware` (`RL_ISSUE` / `RL_VERIFY` /
 *                    `RL_OPERATE`).
 *   - `handle`     — `(c: RouteContext) => Response | Promise<Response>`
 *
 * Cross-cutting helpers (DO stub, dispatch-envelope mapper,
 * fail-response builder, staff capability guard) live in
 * `./_shared.ts`; this file restricts itself to per-endpoint
 * orchestration.
 */
import {
  BusinessTimeZoneSchema,
  constantTimeStringEqual,
  intervalOf,
  isCallableNow,
  reservationsByDeadline,
  type Slot,
  TicketSchema,
} from "@booking/core"
import { Result, Schema } from "effect"
import type { QueueAction } from "../durableObjects/QueueShop.js"
import { dispatchEnvelope, failResponse, okJson, requireStaff, stub } from "./_shared.js"
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
  LateAcknowledgeBodySchema,
  MyTicketQuerySchema,
  NoComeConfirmBodySchema,
  RescheduleBodySchema,
  SlotsQuerySchema,
  StaffCancelBodySchema,
} from "./boundarySchemas.js"
import type { RouteContext, RouteDescriptor } from "./dispatchRoute.js"
import { openApiDocument } from "./openapi.js"
import { parseJsonBody } from "./parseJsonBody.js"

// 1. POST /api/v1/staff/login — exchanges the deployment secret
// for a JWT (response body) + HMAC-signed cookie session. Bearer
// + cookie are both honoured by requireStaff downstream.
const route_staffLogin: RouteDescriptor = {
  method: "POST",
  path: "/api/v1/staff/login",
  handle: (c: RouteContext) => handleStaffLogin(c),
}

// 2. POST /api/v1/tickets — issue (rate-limited per IP, RL_ISSUE).
// ADR-0069: idempotent merge surfaces as 200 OK; a fresh issue
// remains 201 Created. The body carries `merged: true` on the
// merged variant so the web client can show "this is your
// existing ticket" rather than a fresh-issue label.
const route_issueTicket: RouteDescriptor = {
  method: "POST",
  path: "/api/v1/tickets",
  rateLimit: "RL_ISSUE",
  handle: async (c: RouteContext) => {
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
    const result = await stub(c.env).dispatch(action)
    const merged = result.ok && "ticket" in result && result.merged === true
    return dispatchEnvelope(result, merged ? 200 : 201)
  },
}

// 3. GET /api/v1/tickets/me — customer self-fetch (handle in
// querystring). Rate-limited per IP (RL_VERIFY, 30 / min) to slow
// (kana, last4) brute force on a known ticketId. See ADR-0058.
const route_getMyTicket: RouteDescriptor = {
  method: "GET",
  path: "/api/v1/tickets/me",
  rateLimit: "RL_VERIFY",
  handle: async (c: RouteContext) => {
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
    return okJson({ ok: true, ticket })
  },
}

// 4. GET /api/v1/tickets/by-handle?k&p — customer recovery
// primitive (ADR-0069). The handle is the active-set primary
// key, so a 200 response carries the single active ticket for
// the supplied (nameKana, phoneLast4); 404 means "no active
// ticket". Same RL_VERIFY ceiling as /tickets/me, mitigating the
// (kana × last4) enumeration oracle.
const route_getByHandle: RouteDescriptor = {
  method: "GET",
  path: "/api/v1/tickets/by-handle",
  rateLimit: "RL_VERIFY",
  handle: async (c: RouteContext) => {
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
    return okJson({ ok: true, ticket })
  },
}

// 5. POST /api/v1/tickets/:id/check-in — customer-side arrival
// audit for reservation tickets (ADR-0068). The CheckIn use case
// gates on Waiting+reservation+within-window; the void return
// surfaces as `{ ok: true }` (no `ticket` field) on the wire.
const route_checkIn: RouteDescriptor = {
  method: "POST",
  path: "/api/v1/tickets/:id/check-in",
  rateLimit: "RL_VERIFY",
  handle: async (c: RouteContext) => {
    const idR = decodeTicketIdParam(c.req.param("id"))
    if (Result.isFailure(idR)) return failResponse(404, "TicketNotFound", "E_DOM_TICKET_NOT_FOUND")
    return dispatchEnvelope(await stub(c.env).dispatch({ type: "CheckIn", ticketId: idR.success }))
  },
}

// 6. POST /api/v1/tickets/:id/reschedule — atomic appointmentAt
// swap (ADR-0070). Customer path (handle in body) or staff path
// (token via x-staff-token). The new slot's capacity is checked
// excluding the ticket itself so a same-slot reschedule is a
// no-op success.
const route_reschedule: RouteDescriptor = {
  method: "POST",
  path: "/api/v1/tickets/:id/reschedule",
  rateLimit: "RL_VERIFY",
  handle: async (c: RouteContext) => {
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
  },
}

// 7. GET /api/v1/slots — bucket-grid availability for the
// customer's /book picker (ADR-0066 / ADR-0068). Returns one row
// per bucket in the [from, to] window, with `taken` derived from
// the live reservation lane count and `capacity` from
// SLOT_DEFAULT_CAPACITY env (default 2). Does NOT consult the
// (optional) per-bucket `slots` override table — adding that
// lookup is a follow-on for shops that need per-bucket overrides.
const route_listSlots: RouteDescriptor = {
  method: "GET",
  path: "/api/v1/slots",
  handle: async (c: RouteContext) => {
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
        (t.state === "Waiting" || t.state === "Called"),
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
    // Business-hours window (default 09:00–17:00 in the business
    // TZ). The slot grid never advertises off-hours buckets so the
    // customer-facing picker only shows slots staff can actually
    // honour. Override per-deployment via env if a shop runs other
    // hours.
    const businessStartMin = Number(c.env.BUSINESS_HOURS_START_MIN) || 9 * 60
    const businessEndMin = Number(c.env.BUSINESS_HOURS_END_MIN) || 17 * 60
    const startBucket = Math.ceil(businessStartMin / granularity)
    const endBucket = Math.floor(businessEndMin / granularity)
    let cursor = from
    while (cursor.toString() <= to.toString()) {
      for (let b = startBucket; b < endBucket; b += 1) {
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
    return okJson({ ok: true, slots: result })
  },
}

// 8. POST /api/v1/tickets/:id/cancel — staff or customer. Body
// parse must run **before** the path-param TicketId decode so a
// malformed body surfaces as a distinct 400 InvalidPayload (C7);
// id-shape failures fall through to the standard 404
// TicketNotFound. Rate-limited per IP for the customer path (the
// staff cookie / JWT route falls back to RL_OPERATE — applied
// below after the actor is identified).
const route_cancel: RouteDescriptor = {
  method: "POST",
  path: "/api/v1/tickets/:id/cancel",
  rateLimit: "RL_VERIFY",
  handle: async (c: RouteContext) => {
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
  },
}

// 9. GET /api/v1/queue — shop projection v3 (ADR-0062 / 0063 /
// 0065 / 0066 / 0067). Anonymous payload exposes lane /
// displaySeq / appointmentAt + calling[] + serving[] arrays;
// staff payload carries the full ticket rows (PII inclusive).
// `nextReservationDeadline` mirrors the WS broadcast field so
// initial-load and live-update paths converge on the same shape.
const route_getQueue: RouteDescriptor = {
  method: "GET",
  path: "/api/v1/queue",
  handle: async (c: RouteContext) => {
    const tickets = await stub(c.env).listTickets()
    const waiting = tickets
      .filter((t) => t.state === "Waiting")
      .sort((a, b) => a.displaySeq - b.displaySeq)
    // ADR-0073 — Serving was withdrawn as a domain state. The
    // "対応中" array is derived from Called: any Called ticket whose
    // calledAt is older than SERVING_THRESHOLD_MS (default 30s) is
    // assumed to be at the counter. The two arrays are mutually
    // exclusive subsets of Called.
    const nowMs = Date.now()
    const SERVING_THRESHOLD_MS = Number(c.env.SERVING_THRESHOLD_MS) || 30_000
    const calledAll = tickets
      .filter((t) => t.state === "Called")
      .sort((a, b) => a.displaySeq - b.displaySeq)
    const calling = calledAll.filter((t) => {
      const calledMs = Date.parse(t.calledAt)
      if (Number.isNaN(calledMs)) return true
      return calledMs + SERVING_THRESHOLD_MS > nowMs
    })
    const serving = calledAll.filter((t) => {
      const calledMs = Date.parse(t.calledAt)
      if (Number.isNaN(calledMs)) return false
      return calledMs + SERVING_THRESHOLD_MS <= nowMs
    })
    const pendingNoShow = tickets
      .filter((t) => t.state === "PendingNoShow")
      .sort((a, b) => a.displaySeq - b.displaySeq)
    // "Callable now" partition lives in @booking/core (ADR-0078) — a
    // single EDF-lateness lens shared with QueueShop.shopState and
    // the staff card's call-button enabled state.
    const callableNowCount = waiting.filter((t) => isCallableNow(t, nowMs)).length
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
      state: t.state,
    })
    const laneCount = (lane: "walkIn" | "priority" | "reservation") =>
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
    const isStaff =
      c.env.STAFF_SESSION_SECRET !== undefined &&
      c.req.header("x-staff-token") === c.env.STAFF_SESSION_SECRET
    if (isStaff) {
      return okJson({
        ok: true,
        v: 6,
        waitingCount: waiting.length,
        callableNowCount,
        laneCounts: {
          walkIn: laneCount("walkIn"),
          priority: laneCount("priority"),
          reservation: laneCount("reservation"),
        },
        calling,
        serving,
        pendingNoShow,
        waitingPreview: waiting,
        terminal: terminalRecent,
        nextReservationDeadline,
      })
    }
    return okJson({
      ok: true,
      v: 6,
      waitingCount: waiting.length,
      callableNowCount,
      laneCounts: {
        walkIn: laneCount("walkIn"),
        priority: laneCount("priority"),
        reservation: laneCount("reservation"),
      },
      calling: calling.map(project),
      serving: serving.map(project),
      pendingNoShow: pendingNoShow.map(project),
      waitingPreview: waiting.map(project),
      nextReservationDeadline,
    })
  },
}

// 10. POST /api/v1/queue/call-next — staff. Body `{ lane? }`
// chooses a specific lane head; an empty body means
// "preferred-lane chain default" (ADR-0062). Rate-limited per
// token hash (300 / min).
const route_callNext: RouteDescriptor = {
  method: "POST",
  path: "/api/v1/queue/call-next",
  rateLimit: "RL_OPERATE",
  handle: async (c: RouteContext) => {
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
  },
}

// 11. POST /api/v1/queue/call-specific — staff. Body
// `{ ticketId }` (ADR-0065).
const route_callSpecific: RouteDescriptor = {
  method: "POST",
  path: "/api/v1/queue/call-specific",
  rateLimit: "RL_OPERATE",
  handle: async (c: RouteContext) => {
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
  },
}

// 12. POST /api/v1/queue/call-batch — staff. Body
// `{ ticketIds: NonEmpty<TicketId> }` (ADR-0065). Atomic batch:
// any per-member failure rolls every member back; the response
// carries `tickets[]` (every member that landed Called).
const route_callBatch: RouteDescriptor = {
  method: "POST",
  path: "/api/v1/queue/call-batch",
  rateLimit: "RL_OPERATE",
  handle: async (c: RouteContext) => {
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
  },
}

// 13. POST /api/v1/tickets/:id/served — staff
const route_served: RouteDescriptor = {
  method: "POST",
  path: "/api/v1/tickets/:id/served",
  handle: async (c: RouteContext) => {
    const guard = await requireStaff(c)
    if (!guard.ok) return guard.res
    const idR = decodeTicketIdParam(c.req.param("id"))
    if (Result.isFailure(idR)) return failResponse(404, "TicketNotFound", "E_DOM_TICKET_NOT_FOUND")
    return dispatchEnvelope(
      await stub(c.env).dispatch({ type: "MarkServed", ticketId: idR.success }),
    )
  },
}

// 14. POST /api/v1/tickets/:id/no-show — staff. ADR-0074
// redirected this endpoint from immediate NoShow to
// MarkPendingNoShow: the ticket enters the grace window (the
// customer can still respond with 「遅れる」 / 「来ない」), and
// the DO alarm sweeps it into terminal NoShow when GRACE_TTL_MIN
// elapses. The endpoint URL and response shape are unchanged for
// backward compatibility with the existing web client.
const route_noShow: RouteDescriptor = {
  method: "POST",
  path: "/api/v1/tickets/:id/no-show",
  handle: async (c: RouteContext) => {
    const guard = await requireStaff(c)
    if (!guard.ok) return guard.res
    const idR = decodeTicketIdParam(c.req.param("id"))
    if (Result.isFailure(idR)) return failResponse(404, "TicketNotFound", "E_DOM_TICKET_NOT_FOUND")
    return dispatchEnvelope(
      await stub(c.env).dispatch({
        type: "MarkPendingNoShow",
        ticketId: idR.success,
        actor: "staff",
      }),
    )
  },
}

// 15. POST /api/v1/tickets/:id/recall — staff
const route_recall: RouteDescriptor = {
  method: "POST",
  path: "/api/v1/tickets/:id/recall",
  handle: async (c: RouteContext) => {
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
  },
}

// 16. POST /api/v1/tickets/:id/late-acknowledge — customer
// (ADR-0074). The PendingNoShow grace-window response:
// reservation customers reschedule to `now + etaMinutes`;
// walk-in / priority customers are recalled to the lane head
// (the etaMinutes value is recorded for audit but otherwise
// unused). Handle is verified at the boundary against the stored
// ticket — the same threat model as the customer cancel
// endpoint.
const route_lateAcknowledge: RouteDescriptor = {
  method: "POST",
  path: "/api/v1/tickets/:id/late-acknowledge",
  rateLimit: "RL_VERIFY",
  handle: async (c: RouteContext) => {
    const idR = decodeTicketIdParam(c.req.param("id"))
    if (Result.isFailure(idR)) {
      return failResponse(404, "TicketNotFound", "E_DOM_TICKET_NOT_FOUND")
    }
    const parsed = await parseJsonBody(c)
    if (!parsed.ok) {
      return failResponse(parsed.status, parsed.tag, parsed.code, { reason: parsed.reason })
    }
    const decoded = Schema.decodeUnknownResult(LateAcknowledgeBodySchema)(parsed.raw)
    if (Result.isFailure(decoded)) {
      const fail = dispatchDecodeFailure(decoded.failure)
      return failResponse(fail.status, fail.tag, fail.code)
    }
    const ticketId = idR.success
    const ticket = await stub(c.env).getTicketById(ticketId)
    if (ticket === null) {
      return failResponse(404, "TicketNotFound", "E_DOM_TICKET_NOT_FOUND")
    }
    if (
      ticket.nameKana !== decoded.success.nameKana ||
      ticket.phoneLast4 !== decoded.success.phoneLast4
    ) {
      return failResponse(403, "PhoneMismatch", "E_DOM_PHONE_MISMATCH")
    }
    const handle = {
      nameKana: decoded.success.nameKana,
      phoneLast4: decoded.success.phoneLast4,
    }
    if (ticket.lane === "reservation") {
      const granularity = (Number(c.env.SLOT_DEFAULT_GRANULARITY) || 30) as 15 | 30 | 60
      const tz = c.env.DEPLOYMENT_TIMEZONE ?? "Asia/Tokyo"
      const capacity = Number(c.env.SLOT_DEFAULT_CAPACITY) || 2
      const newAppointmentAt = new Date(
        Date.now() + decoded.success.etaMinutes * 60_000,
      ).toISOString()
      return dispatchEnvelope(
        await stub(c.env).dispatch({
          type: "RescheduleTicket",
          ticketId,
          newAppointmentAt,
          granularity,
          tz,
          capacity,
          actor: "customer",
          handle,
        }),
      )
    }
    // walk-in / priority — recall to lane head; etaMinutes is not
    // semantically meaningful here (no slot to move) but the
    // boundary already accepted it for audit consistency.
    return dispatchEnvelope(
      await stub(c.env).dispatch({
        type: "Recall",
        ticketId,
        actor: "customer",
      }),
    )
  },
}

// 17. POST /api/v1/tickets/:id/no-come-confirm — customer
// (ADR-0074). The PendingNoShow grace-window 「来ない」 response:
// cancel with `actor=customer` and the supplied / default
// reason.
const route_noComeConfirm: RouteDescriptor = {
  method: "POST",
  path: "/api/v1/tickets/:id/no-come-confirm",
  rateLimit: "RL_VERIFY",
  handle: async (c: RouteContext) => {
    const idR = decodeTicketIdParam(c.req.param("id"))
    if (Result.isFailure(idR)) {
      return failResponse(404, "TicketNotFound", "E_DOM_TICKET_NOT_FOUND")
    }
    const parsed = await parseJsonBody(c)
    if (!parsed.ok) {
      return failResponse(parsed.status, parsed.tag, parsed.code, { reason: parsed.reason })
    }
    const decoded = Schema.decodeUnknownResult(NoComeConfirmBodySchema)(parsed.raw)
    if (Result.isFailure(decoded)) {
      const fail = dispatchDecodeFailure(decoded.failure)
      return failResponse(fail.status, fail.tag, fail.code)
    }
    return dispatchEnvelope(
      await stub(c.env).dispatch({
        type: "CancelTicket",
        ticketId: idR.success,
        actor: "customer",
        reason: decoded.success.reason ?? "no-come",
        handle: {
          nameKana: decoded.success.nameKana,
          phoneLast4: decoded.success.phoneLast4,
        },
      }),
    )
  },
}

// 18. GET /api/v1/openapi.json — OpenAPI 3.1 document
const route_openapi: RouteDescriptor = {
  method: "GET",
  path: "/api/v1/openapi.json",
  handle: (_c: RouteContext) => {
    return new Response(JSON.stringify(openApiDocument), {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "public, max-age=300",
      },
    })
  },
}

// 19. GET /api/v1/queue/feed — DO Hibernating WebSocket
// projection feed. Replaces the 2 s SSE polling loop with a
// server-push stream the QueueShop DO emits on every successful
// dispatch. The router verifies staff credentials before
// forwarding the upgrade and rewrites the URL with
// `?capability=staff` so the DO can tag the accepted socket.
// Anonymous upgrades pass through untagged and receive the
// PII-free frame variant (ADR-0061 / ADR-0083 capability
// fan-out).
const route_queueFeed: RouteDescriptor = {
  method: "GET",
  path: "/api/v1/queue/feed",
  handle: async (c: RouteContext) => {
    if (c.req.header("upgrade") !== "websocket") {
      return c.text("Expected websocket upgrade", 426)
    }
    const guard = await requireStaff(c)
    const upgradeUrl = new URL(c.req.raw.url)
    if (guard.ok) {
      upgradeUrl.searchParams.set("capability", "staff")
    } else {
      upgradeUrl.searchParams.delete("capability")
    }
    const id = c.env.QUEUE_SHOP.idFromName("shop")
    const obj = c.env.QUEUE_SHOP.get(id)
    const forwarded = new Request(upgradeUrl, c.req.raw)
    return obj.fetch(forwarded)
  },
}

/**
 * The compiled-time list of every `/api/v1/*` endpoint. Order
 * matches the original `router.ts` registration order so
 * trie-construction and behavioural compatibility are preserved
 * one-to-one.
 */
export const ROUTES: readonly RouteDescriptor[] = [
  route_staffLogin,
  route_issueTicket,
  route_getMyTicket,
  route_getByHandle,
  route_checkIn,
  route_reschedule,
  route_listSlots,
  route_cancel,
  route_getQueue,
  route_callNext,
  route_callSpecific,
  route_callBatch,
  route_served,
  route_noShow,
  route_recall,
  route_lateAcknowledge,
  route_noComeConfirm,
  route_openapi,
  route_queueFeed,
]
