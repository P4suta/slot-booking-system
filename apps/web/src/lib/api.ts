import { apiBaseUrl } from "./baseUrl.js"

const baseUrl = apiBaseUrl

type ErrorEnvelope = {
  readonly _tag: string
  readonly code: string
  readonly reason?: string
}

export type Lane = "walkIn" | "priority" | "reservation"

export type Ticket = {
  readonly id: string
  readonly seq: number
  readonly lane: Lane
  readonly displaySeq: number
  readonly state: "Waiting" | "Called" | "Serving" | "Served" | "NoShow" | "Cancelled"
  readonly nameKana: string | null
  readonly phoneLast4: string | null
  readonly freeText: string | null
  readonly issuedAt: string
  readonly calledAt?: string
  readonly servingStartedAt?: string
  readonly servedAt?: string
  readonly cancelledAt?: string
  readonly markedAt?: string
}

export type ProjectionEntry = {
  readonly id: string
  readonly seq: number
  readonly lane: Lane
  readonly displaySeq: number
}

export type LaneCounts = {
  readonly walkIn: number
  readonly priority: number
  readonly reservation: number
}

/**
 * v2 anonymous shop projection (ADR-0062 / ADR-0063 / ADR-0065).
 * Lane-aware preview, `calling[]` + `serving[]` arrays, and
 * `laneCounts` so the client renders the same shape from
 * `GET /api/v1/queue` and the WebSocket feed.
 */
export type ShopState = {
  readonly v: 2
  readonly waitingCount: number
  readonly laneCounts: LaneCounts
  readonly calling: readonly ProjectionEntry[]
  readonly serving: readonly ProjectionEntry[]
  readonly waitingPreview: readonly ProjectionEntry[]
}

/**
 * Staff-only shape: PII (nameKana / phoneLast4 / freeText) のせ。
 * v2 では calling / serving / waitingPreview のすべてが full Ticket
 * row を carry。 `x-staff-token` 付き GET /api/v1/queue で返る。
 */
export type StaffShopState = {
  readonly v: 2
  readonly waitingCount: number
  readonly laneCounts: LaneCounts
  readonly calling: readonly Ticket[]
  readonly serving: readonly Ticket[]
  readonly waitingPreview: readonly Ticket[]
}

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

export const issueTicket = async (input: {
  nameKana: string
  phoneLast4: string
  freeText: string | null
  lane?: Lane
}): Promise<ApiResult<{ ticket: Ticket }>> =>
  fetchJson(`${baseUrl()}/api/v1/tickets`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  })

export const myTicket = async (input: {
  ticketId: string
  nameKana: string
  phoneLast4: string
}): Promise<ApiResult<{ ticket: Ticket }>> => {
  const params = new URLSearchParams(input)
  return fetchJson(`${baseUrl()}/api/v1/tickets/me?${params.toString()}`)
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

export const shopState = async (): Promise<ApiResult<ShopState>> =>
  fetchJson(`${baseUrl()}/api/v1/queue`)

/**
 * Staff 権限版 shopState — preview に PII (kana / 末尾4 / freeText) が
 * 同梱される。 token を付けたまま public endpoint を叩くだけで sub-path
 * は変わらない (worker 側で `x-staff-token` をチェックして branch)。
 */
export const staffShopState = async (token: string): Promise<ApiResult<StaffShopState>> =>
  fetchJson(`${baseUrl()}/api/v1/queue`, {
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

export const callNext = async (
  token: string,
  body: { lane?: Lane } = {},
): Promise<ApiResult<{ ticket: Ticket }>> =>
  fetchJson(`${baseUrl()}/api/v1/queue/call-next`, {
    method: "POST",
    headers: staffHeaders(token),
    body: body.lane !== undefined ? JSON.stringify({ lane: body.lane }) : undefined,
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

export const callBatch = async (
  token: string,
  ticketIds: readonly string[],
): Promise<ApiResult<{ tickets: readonly Ticket[] }>> =>
  fetchJson(`${baseUrl()}/api/v1/queue/call-batch`, {
    method: "POST",
    headers: staffHeaders(token),
    body: JSON.stringify({ ticketIds }),
  })

export const startServing = async (
  token: string,
  ticketId: string,
): Promise<ApiResult<{ ticket: Ticket }>> =>
  fetchJson(`${baseUrl()}/api/v1/tickets/${ticketId}/start-serving`, {
    method: "POST",
    headers: staffHeaders(token),
  })

export const reorder = async (
  token: string,
  body: { ticketId: string; afterTicketId: string | null },
): Promise<ApiResult<{ ticket: Ticket }>> =>
  fetchJson(`${baseUrl()}/api/v1/queue/reorder`, {
    method: "POST",
    headers: staffHeaders(token),
    body: JSON.stringify(body),
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
