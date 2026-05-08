import { type CustomerHandle, codeOf, parseCustomerHandle, parseTicketId } from "@booking/core"
import { Result, Schema } from "effect"
import type { QueueAction, QueueResult, QueueShop } from "../durableObjects/QueueShop.js"

/**
 * REST + SSE surface for the queue: 5 POSTs (one per use case),
 * 2 GETs (shop state + personal ticket), 1 SSE stream (live
 * projection). Effect-Schema parses the request, QueueShop dispatch
 * runs the use case, the response is a JSON envelope.
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

// CORS for apps/web dev (Vite :5173) hitting wrangler dev (:8787).
// Production uses a single Cloudflare zone so the path stays
// same-origin; `*` is acceptable in dev because the surface carries
// no cookies and the staff token is opt-in via header.
const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, x-staff-token",
  "access-control-max-age": "86400",
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...corsHeaders },
  })

const fail = (status: number, _tag: string, code: string, extra: Record<string, unknown> = {}) =>
  json(status, { ok: false, error: { _tag, code, ...extra } })

const statusForError = (tag: string): number => {
  if (tag === "TicketNotFound") return 404
  if (tag === "PhoneMismatch") return 403
  if (tag === "QueueEmpty") return 409
  if (
    tag === "AlreadyCancelled" ||
    tag === "AlreadyCompleted" ||
    tag === "AlreadyNoShow" ||
    tag === "InvalidStateTransition"
  )
    return 409
  if (tag === "Concurrency") return 409
  if (tag.startsWith("Invalid")) return 422
  return 500
}

const dispatchOk = (result: QueueResult, status = 200) =>
  result.ok
    ? json(status, { ok: true, ticket: result.ticket })
    : fail(statusForError(result.error._tag), result.error._tag, result.error.code)

const requireOperateQueue = (
  request: Request,
  staffSecret: string | undefined,
): Response | null => {
  if (staffSecret === undefined) {
    return fail(503, "MissingStaffCapability", "E_VAL_MISSING_STAFF_CAPABILITY", {
      reason: "absent",
    })
  }
  const presented = request.headers.get("x-staff-token")
  if (presented !== staffSecret) {
    return fail(401, "MissingStaffCapability", "E_VAL_MISSING_STAFF_CAPABILITY", {
      reason: presented === null ? "absent" : "wrong_kind",
    })
  }
  return null
}

const parseHandleFromBody = (
  body: unknown,
):
  | { ok: true; handle: CustomerHandle; rest: Record<string, unknown> }
  | { ok: false; res: Response } => {
  if (typeof body !== "object" || body === null) {
    return { ok: false, res: fail(400, "InvalidBody", "E_VAL_BODY") }
  }
  const rec = body as Record<string, unknown>
  const handleR = parseCustomerHandle(String(rec.nameKana ?? ""), String(rec.phoneLast4 ?? ""))
  if (Result.isFailure(handleR)) {
    return {
      ok: false,
      res: fail(422, handleR.failure._tag, codeOf(handleR.failure)),
    }
  }
  return { ok: true, handle: handleR.success, rest: rec }
}

type Env = {
  QUEUE_SHOP: DurableObjectNamespace<QueueShop>
  STAFF_SESSION_SECRET?: string
}

const stub = (env: Env) =>
  env.QUEUE_SHOP.get(env.QUEUE_SHOP.idFromName("shop")) as unknown as QueueShop

/**
 * Route a single API request. Returns `null` when the path is not a
 * queue endpoint so the caller can fall through to other handlers.
 */
export const routeQueueApi = async (request: Request, env: Env): Promise<Response | null> => {
  const url = new URL(request.url)
  const path = url.pathname

  // CORS preflight — all `/api/v1/*` endpoints accept the same matrix.
  if (request.method === "OPTIONS" && path.startsWith("/api/v1/")) {
    return new Response(null, { status: 204, headers: corsHeaders })
  }

  // --- Issue ---
  if (path === "/api/v1/tickets" && request.method === "POST") {
    const raw = await request.json().catch(() => null)
    const decoded = Schema.decodeUnknownResult(IssueTicketBodySchema)(raw)
    if (Result.isFailure(decoded)) return fail(422, "InvalidBody", "E_VAL_BODY")
    const handleR = parseCustomerHandle(decoded.success.nameKana, decoded.success.phoneLast4)
    if (Result.isFailure(handleR)) return fail(422, handleR.failure._tag, codeOf(handleR.failure))
    const action: QueueAction = {
      type: "IssueTicket",
      handle: handleR.success,
      freeText: decoded.success.freeText,
    }
    const result = await stub(env).dispatch(action)
    return dispatchOk(result, 201)
  }

  // --- MyTicket (customer) ---
  if (path === "/api/v1/tickets/me" && request.method === "GET") {
    const decoded = Schema.decodeUnknownResult(MyTicketQuerySchema)({
      ticketId: url.searchParams.get("ticketId"),
      nameKana: url.searchParams.get("nameKana"),
      phoneLast4: url.searchParams.get("phoneLast4"),
    })
    if (Result.isFailure(decoded)) return fail(422, "InvalidQuery", "E_VAL_QUERY")
    const idR = parseTicketId(decoded.success.ticketId)
    if (Result.isFailure(idR)) return fail(404, "TicketNotFound", "E_DOM_TICKET_NOT_FOUND")
    const all = await stub(env).listTickets()
    const ticket = all.find((t) => t.id === idR.success)
    if (ticket === undefined) return fail(404, "TicketNotFound", "E_DOM_TICKET_NOT_FOUND")
    if (
      (ticket.nameKana as string) !== decoded.success.nameKana ||
      (ticket.phoneLast4 as string) !== decoded.success.phoneLast4
    )
      return fail(403, "PhoneMismatch", "E_DOM_PHONE_MISMATCH")
    return json(200, { ok: true, ticket })
  }

  // --- Cancel (customer or staff) ---
  const cancelMatch = path.match(/^\/api\/v1\/tickets\/([^/]+)\/cancel$/)
  if (cancelMatch && request.method === "POST") {
    const idR = parseTicketId(cancelMatch[1] as string)
    if (Result.isFailure(idR)) return fail(404, "TicketNotFound", "E_DOM_TICKET_NOT_FOUND")
    const isStaff = request.headers.get("x-staff-token") !== null
    if (isStaff) {
      const guard = requireOperateQueue(request, env.STAFF_SESSION_SECRET)
      if (guard !== null) return guard
      const raw = await request.json().catch(() => null)
      const reason =
        typeof raw === "object" && raw !== null && "reason" in raw
          ? String((raw as { reason: unknown }).reason ?? "")
          : ""
      return dispatchOk(
        await stub(env).dispatch({
          type: "CancelTicket",
          ticketId: idR.success,
          actor: "staff",
          reason,
        }),
      )
    }
    const raw = await request.json().catch(() => null)
    const decoded = Schema.decodeUnknownResult(CancelBodySchema)(raw)
    if (Result.isFailure(decoded)) return fail(422, "InvalidBody", "E_VAL_BODY")
    const parsed = parseHandleFromBody(decoded.success)
    if (!parsed.ok) return parsed.res
    return dispatchOk(
      await stub(env).dispatch({
        type: "CancelTicket",
        ticketId: idR.success,
        actor: "customer",
        reason: decoded.success.reason,
        handle: parsed.handle,
      }),
    )
  }

  // --- Shop state (public + staff) ---
  // staff token を持参すると preview / serving に PII を同梱して
  // 受付業務に使える形で返す。 持参しない場合は ID + seq のみで
  // 顧客 landing の混雑表示用 (Iron Principles の minimum-PII 維持)。
  if (path === "/api/v1/queue" && request.method === "GET") {
    const tickets = await stub(env).listTickets()
    const waiting = tickets.filter((t) => t.state === "Waiting").sort((a, b) => a.seq - b.seq)
    const serving = tickets.find((t) => t.state === "Called") ?? null
    const isStaff =
      env.STAFF_SESSION_SECRET !== undefined &&
      request.headers.get("x-staff-token") === env.STAFF_SESSION_SECRET
    if (isStaff) {
      return json(200, {
        ok: true,
        waitingCount: waiting.length,
        serving,
        waitingPreview: waiting.slice(0, 20),
      })
    }
    return json(200, {
      ok: true,
      waitingCount: waiting.length,
      serving: serving === null ? null : { id: serving.id, seq: serving.seq },
      waitingPreview: waiting.slice(0, 10).map((t) => ({ id: t.id, seq: t.seq })),
    })
  }

  // --- Staff: call next ---
  if (path === "/api/v1/queue/call-next" && request.method === "POST") {
    const guard = requireOperateQueue(request, env.STAFF_SESSION_SECRET)
    if (guard !== null) return guard
    return dispatchOk(await stub(env).dispatch({ type: "CallNext", actor: "staff" }))
  }

  // --- Staff: mark served ---
  const servedMatch = path.match(/^\/api\/v1\/tickets\/([^/]+)\/served$/)
  if (servedMatch && request.method === "POST") {
    const guard = requireOperateQueue(request, env.STAFF_SESSION_SECRET)
    if (guard !== null) return guard
    const idR = parseTicketId(servedMatch[1] as string)
    if (Result.isFailure(idR)) return fail(404, "TicketNotFound", "E_DOM_TICKET_NOT_FOUND")
    return dispatchOk(await stub(env).dispatch({ type: "MarkServed", ticketId: idR.success }))
  }

  // --- Staff: mark no-show ---
  const noShowMatch = path.match(/^\/api\/v1\/tickets\/([^/]+)\/no-show$/)
  if (noShowMatch && request.method === "POST") {
    const guard = requireOperateQueue(request, env.STAFF_SESSION_SECRET)
    if (guard !== null) return guard
    const idR = parseTicketId(noShowMatch[1] as string)
    if (Result.isFailure(idR)) return fail(404, "TicketNotFound", "E_DOM_TICKET_NOT_FOUND")
    return dispatchOk(
      await stub(env).dispatch({
        type: "MarkNoShow",
        ticketId: idR.success,
        actor: "staff",
      }),
    )
  }

  // --- Staff: recall (undo accidental call-next) ---
  // Called → Waiting; the audit log retains both events. The caller
  // passes the ticket id so a stale click after a colleague already
  // moved the ticket on fails with InvalidStateTransition (409)
  // rather than recalling whoever happens to be Called now.
  const recallMatch = path.match(/^\/api\/v1\/tickets\/([^/]+)\/recall$/)
  if (recallMatch && request.method === "POST") {
    const guard = requireOperateQueue(request, env.STAFF_SESSION_SECRET)
    if (guard !== null) return guard
    const idR = parseTicketId(recallMatch[1] as string)
    if (Result.isFailure(idR)) return fail(404, "TicketNotFound", "E_DOM_TICKET_NOT_FOUND")
    return dispatchOk(
      await stub(env).dispatch({
        type: "Recall",
        ticketId: idR.success,
        actor: "staff",
      }),
    )
  }

  // --- Subscription via SSE ---
  if (path === "/api/v1/queue/events" && request.method === "GET") {
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder()
        const send = (data: unknown) =>
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
        const sendOnce = async () => {
          const tickets = await stub(env).listTickets()
          const waiting = tickets.filter((t) => t.state === "Waiting")
          const serving = tickets.find((t) => t.state === "Called") ?? null
          send({
            ok: true,
            waitingCount: waiting.length,
            serving,
            waitingPreview: waiting
              .sort((a, b) => a.seq - b.seq)
              .slice(0, 10)
              .map((t) => ({ id: t.id, seq: t.seq })),
          })
        }
        await sendOnce()
        // Cloudflare Workers cap the long-lived stream; the client
        // re-connects automatically after the cap or any disconnect.
        const interval = setInterval(() => {
          sendOnce().catch(() => controller.close())
        }, 2000)
        const cleanup = () => {
          clearInterval(interval)
          try {
            controller.close()
          } catch {
            // controller already closed
          }
        }
        // Close after 30s so we never overrun the Workers stream
        // budget; the client reconnects.
        setTimeout(cleanup, 30000)
      },
    })
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
        ...corsHeaders,
      },
    })
  }

  return null
}
