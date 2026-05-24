import type {
  ProjectionEntry as GeneratedProjectionEntry,
  Ticket as GeneratedTicket,
  paths,
} from "../generated/openapi.js"
import { apiBaseUrl } from "./baseUrl.js"

const baseUrl = apiBaseUrl

type ErrorEnvelope = {
  readonly _tag: string
  readonly code: string
  readonly reason?: string
}

/**
 * ADR-0083 + ADR-0084 — every wire type is derived from
 * `docs/openapi.json` via `openapi-typescript`. ADR-0084 split the
 * legacy header-discriminated `/queue` into two paths with
 * statically known shapes (`/queue` anonymous, `/queue/staff` full
 * Ticket); the corresponding `ShopState` / `StaffShopState`
 * aliases are now path-derived rather than hand-written.
 *
 * Wire-level aliases:
 *   - `Ticket` is the unified discriminated wire image of the six
 *     ticket states. OpenAPI's flat-object form collapses the union
 *     to "common fields required, state-specific fields optional";
 *     consumers narrow by `state` at the call site.
 *   - `ProjectionEntry` is the PII-free shape `/queue` returns in
 *     its `calling` / `overdue` / `waitingPreview` arrays.
 *   - `ShopState` / `StaffShopState` are the two response envelopes
 *     for the split `/queue` / `/queue/staff` endpoints.
 *   - `SlotEntry`, `IssueTicketBody` extract reusable shapes from
 *     the generated paths so route bodies don't repeat the deep
 *     nested type expressions.
 */
export type Ticket = GeneratedTicket

export type SlotEntry =
  paths["/slots"]["get"]["responses"]["200"]["content"]["application/json"]["slots"][number]

type IssueTicketBody = paths["/tickets"]["post"]["requestBody"]["content"]["application/json"]

export type ProjectionEntry = GeneratedProjectionEntry

export type ShopState = paths["/queue"]["get"]["responses"]["200"]["content"]["application/json"]

export type StaffShopState =
  paths["/queue/staff"]["get"]["responses"]["200"]["content"]["application/json"]

/**
 * Tagged-union return for every REST call (C12). The frontend can
 * pattern-match on `kind` instead of folding network / parse /
 * domain failures into one indistinct `error.code = E_NET_<status>`
 * placeholder. `traceId` is the `X-Trace-Id` response header (if
 * the server attached one) so the customer-reported failure can be
 * pivoted to the structured-log row by trace id.
 */
export type ApiResult<A> =
  | { readonly ok: true; readonly value: A; readonly traceId: string | null }
  | {
      readonly ok: false
      readonly kind: "NetworkError" | "InvalidEnvelope" | "DomainError"
      readonly status: number
      readonly error: ErrorEnvelope
      readonly traceId: string | null
    }

const synthError = (kind: string, status: number): ErrorEnvelope => ({
  _tag: kind,
  code: `E_${kind === "NetworkError" ? "NET" : "ENVELOPE"}_${String(status)}`,
})

const json = async <A>(res: Response): Promise<ApiResult<A>> => {
  const traceId = res.headers.get("x-trace-id")
  let body: unknown
  try {
    body = await res.json()
  } catch {
    return {
      ok: false,
      kind: "NetworkError",
      status: res.status,
      error: synthError("NetworkError", res.status),
      traceId,
    }
  }
  if (typeof body !== "object" || body === null) {
    return {
      ok: false,
      kind: "InvalidEnvelope",
      status: res.status,
      error: synthError("InvalidEnvelope", res.status),
      traceId,
    }
  }
  const b = body as { ok?: unknown; error?: unknown }
  if (res.ok && b.ok === true) {
    return { ok: true, value: body as A, traceId }
  }
  if (typeof b.error === "object" && b.error !== null) {
    return {
      ok: false,
      kind: "DomainError",
      status: res.status,
      error: b.error as ErrorEnvelope,
      traceId,
    }
  }
  return {
    ok: false,
    kind: "InvalidEnvelope",
    status: res.status,
    error: synthError("InvalidEnvelope", res.status),
    traceId,
  }
}

const fetchJson = async <A>(input: string, init?: RequestInit): Promise<ApiResult<A>> => {
  let res: Response
  try {
    res = await fetch(input, init)
  } catch {
    return {
      ok: false,
      kind: "NetworkError",
      status: 0,
      error: synthError("NetworkError", 0),
      traceId: null,
    }
  }
  return json<A>(res)
}

export const issueTicket = async (
  input: IssueTicketBody,
): Promise<ApiResult<{ readonly ticket: Ticket; readonly merged?: true }>> =>
  fetchJson(`${baseUrl()}/api/v1/tickets`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  })

export const listSlots = async (input: {
  from: string
  to: string
  granularity: 15 | 30 | 60
}): Promise<ApiResult<{ slots: readonly SlotEntry[] }>> => {
  const params = new URLSearchParams({
    from: input.from,
    to: input.to,
    granularity: String(input.granularity),
  })
  return fetchJson(`${baseUrl()}/api/v1/slots?${params.toString()}`)
}

/**
 * Customer-side arrival audit for reservation tickets (ADR-0068).
 * Server returns `{ ok: true }` with no `ticket` field; the caller
 * triggers a `myTicket` refresh to read the post-check-in state.
 */
export const checkIn = async (ticketId: string): Promise<ApiResult<Record<string, never>>> =>
  fetchJson(`${baseUrl()}/api/v1/tickets/${ticketId}/check-in`, {
    method: "POST",
  })

/**
 * Customer-side handle lookup (ADR-0069). The handle is the
 * active-set primary key, so this returns the unique active
 * ticket if any. 404 → null wrapper would lose the ApiResult
 * discrimination; callers inspect `r.ok === false && r.error._tag
 * === "TicketNotFound"` to detect the "no active ticket" branch.
 * Supersedes the ADR-0064 `myTicket(ticketId, kana, last4)` lookup
 * which required the customer to bring the ticketId.
 */
export const ticketByHandle = async (input: {
  nameKana: string
  phoneLast4: string
}): Promise<ApiResult<{ ticket: Ticket }>> => {
  const params = new URLSearchParams(input)
  return fetchJson(`${baseUrl()}/api/v1/tickets/by-handle?${params.toString()}`)
}

export const cancelTicket = async (
  ticketId: string,
  body: { nameKana: string; phoneLast4: string; reason: string },
): Promise<ApiResult<{ ticket: Ticket }>> =>
  fetchJson(`${baseUrl()}/api/v1/tickets/${ticketId}/cancel`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

// ADR-0070 — atomic appointmentAt swap. Customer path: handle is
// passed in the body so the server can verify it (constant-time
// compare against the stored ticket). Same handle gates as
// `cancelTicket`. The new slot's capacity is checked excluding
// `ticketId` itself, so submitting the current appointmentAt is a
// no-op success rather than a 409.
export const rescheduleTicket = async (
  ticketId: string,
  body: { nameKana: string; phoneLast4: string; newAppointmentAt: string },
): Promise<ApiResult<{ ticket: Ticket }>> =>
  fetchJson(`${baseUrl()}/api/v1/tickets/${ticketId}/reschedule`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

export const shopState = async (): Promise<ApiResult<ShopState>> =>
  fetchJson(`${baseUrl()}/api/v1/queue`)

/**
 * Staff 権限版 shopState — preview に PII (kana / 末尾4 / freeText) が
 * 同梱される。 ADR-0084 で `/queue` (anonymous) と `/queue/staff` (PII
 * inclusive) を別 path に分割。 client は path を選ぶだけで auth header
 * の意味的役割が無くなった (token はもちろん必要)。
 */
export const staffShopState = async (token: string): Promise<ApiResult<StaffShopState>> =>
  fetchJson(`${baseUrl()}/api/v1/queue/staff`, {
    headers: { "x-staff-token": token },
  })

const wsUrl = (): string => {
  const http = baseUrl()
  return http === ""
    ? `${typeof window !== "undefined" && window.location.protocol === "https:" ? "wss" : "ws"}://${typeof window !== "undefined" ? window.location.host : ""}`
    : http.replace(/^http/, "ws")
}

export type QueueFeedState = "connecting" | "open" | "reconnecting" | "closed"

export type QueueFeedHandle = {
  readonly close: () => void
  readonly state: () => QueueFeedState
}

export type QueueFeedCallbacks = {
  readonly onProjection: (parsed: unknown) => void
  readonly onState?: (state: QueueFeedState) => void
  readonly onError?: (kind: "ParseError" | "NetworkError", err?: unknown) => void
}

const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000, 4000, 4000, 4000, 4000, 4000, 4000] as const

/**
 * Reconnecting WebSocket projection feed (C12). The handler owns:
 *
 *   - exponential-backoff reconnect (0.5 / 1 / 2 / 4 s, capped at
 *     4 s for attempts past the fourth, max 10 attempts) so a
 *     transient outage doesn't strand the customer landing.
 *   - JSON-parse failure isolation: a malformed message surfaces
 *     through `onError("ParseError", err)` rather than tripping
 *     the message handler's own try/catch silently.
 *   - lifecycle visibility: `onState(...)` fires on every state
 *     transition so the caller can render a "再接続中..." banner.
 *
 * Returns a handle with `close()` for the caller's `onDestroy` and
 * `state()` for ad-hoc inspection.
 */
export const connectQueueFeed = (callbacks: QueueFeedCallbacks): QueueFeedHandle => {
  let attempt = 0
  let manualClose = false
  let socket: WebSocket | null = null
  let currentState: QueueFeedState = "connecting"

  const setState = (next: QueueFeedState): void => {
    currentState = next
    callbacks.onState?.(next)
  }

  const connect = (): void => {
    socket = new WebSocket(`${wsUrl()}/api/v1/queue/feed`)
    socket.onopen = () => {
      attempt = 0
      setState("open")
    }
    socket.onmessage = (event: MessageEvent<string>) => {
      try {
        const parsed: unknown = JSON.parse(event.data)
        callbacks.onProjection(parsed)
      } catch (err) {
        callbacks.onError?.("ParseError", err)
      }
    }
    socket.onerror = (err) => {
      callbacks.onError?.("NetworkError", err)
    }
    socket.onclose = () => {
      if (manualClose || attempt >= RECONNECT_DELAYS_MS.length) {
        setState("closed")
        return
      }
      const delay = RECONNECT_DELAYS_MS[attempt]
      attempt += 1
      setState("reconnecting")
      setTimeout(connect, delay)
    }
  }

  connect()

  return {
    close: (): void => {
      manualClose = true
      socket?.close(1000, "client-done")
    },
    state: (): QueueFeedState => currentState,
  }
}

/* -------------------------------------------------------------------------- */
/* Staff actions — protected by x-staff-token.                                */
/* -------------------------------------------------------------------------- */

const staffHeaders = (token: string) => ({
  "content-type": "application/json",
  "x-staff-token": token,
})

export const callSpecific = async (
  token: string,
  ticketId: string,
): Promise<ApiResult<{ ticket: Ticket }>> =>
  fetchJson(`${baseUrl()}/api/v1/queue/call-specific`, {
    method: "POST",
    headers: staffHeaders(token),
    body: JSON.stringify({ ticketId }),
  })

export const markServed = async (
  token: string,
  ticketId: string,
): Promise<ApiResult<{ ticket: Ticket }>> =>
  fetchJson(`${baseUrl()}/api/v1/tickets/${ticketId}/served`, {
    method: "POST",
    headers: staffHeaders(token),
  })

export const markNoShow = async (
  token: string,
  ticketId: string,
): Promise<ApiResult<{ ticket: Ticket }>> =>
  fetchJson(`${baseUrl()}/api/v1/tickets/${ticketId}/no-show`, {
    method: "POST",
    headers: staffHeaders(token),
  })

/**
 * Recall a mistakenly-called ticket: Called → Waiting. The ticket
 * keeps its original `seq` so it returns to the head of the queue;
 * the worker emits a `Recalled` event alongside the original `Called`
 * for audit. Surfaces the same `InvalidStateTransition` (409) the
 * other staff actions do when racing with a colleague.
 */
export const recall = async (
  token: string,
  ticketId: string,
): Promise<ApiResult<{ ticket: Ticket }>> =>
  fetchJson(`${baseUrl()}/api/v1/tickets/${ticketId}/recall`, {
    method: "POST",
    headers: staffHeaders(token),
  })

export const staffCancel = async (
  token: string,
  ticketId: string,
  reason: string,
): Promise<ApiResult<{ ticket: Ticket }>> =>
  fetchJson(`${baseUrl()}/api/v1/tickets/${ticketId}/cancel`, {
    method: "POST",
    headers: staffHeaders(token),
    body: JSON.stringify({ reason }),
  })

/**
 * Register a Web Push subscription for the customer's active ticket
 * (ADR-0073). Customer-authenticated: handle `(nameKana, phoneLast4)`
 * is verified server-side against the ticket's stored handle
 * (cancel-pattern parity). The browser-side PushManager produces an
 * opaque endpoint URL + `(p256dh, auth)` ECDH material; the back-end
 * stores the row, gates the endpoint origin to the known push
 * services, and reaps it on terminal transition (ADR-0074).
 */
export const registerPushSubscription = async (
  ticketId: string,
  body: {
    nameKana: string
    phoneLast4: string
    endpoint: string
    p256dh: string
    auth: string
  },
): Promise<ApiResult<{ readonly ok: true }>> =>
  fetchJson(`${baseUrl()}/api/v1/tickets/${ticketId}/push-subscription`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

/**
 * Unregister a previously-registered Web Push subscription. Customer-
 * authenticated via query string (DELETE bodies are non-portable).
 */
export const unregisterPushSubscription = async (
  ticketId: string,
  handle: { nameKana: string; phoneLast4: string },
  endpoint: string,
): Promise<ApiResult<{ readonly ok: true }>> => {
  const params = new URLSearchParams({
    nameKana: handle.nameKana,
    phoneLast4: handle.phoneLast4,
    endpoint,
  })
  return fetchJson(
    `${baseUrl()}/api/v1/tickets/${ticketId}/push-subscription?${params.toString()}`,
    { method: "DELETE" },
  )
}
