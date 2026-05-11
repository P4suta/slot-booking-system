import {
  applyShopStateDelta,
  type LaneCounts,
  type ProjectionEntry,
  type ShopState,
  type ShopStateDelta,
} from "@booking/core"
import { apiBaseUrl } from "./baseUrl.js"

// ADR-0086 — wire types re-export from @booking/core. The web side
// no longer hand-maintains `ProjectionEntry` / `ShopState`; any
// future field addition on the server's `packages/core/src/projection
// /shopState.ts` flows into the client as a type-level update, and
// the `ShopState.v: 6` literal (ADR-0081) catches an envelope-version
// mismatch at compile time. `LaneCounts` stays internal (it is only
// referenced by `StaffShopState` inside this module).
export type { ProjectionEntry, ShopState }

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
  readonly state: "Waiting" | "Called" | "PendingNoShow" | "Served" | "NoShow" | "Cancelled"
  readonly nameKana: string | null
  readonly phoneLast4: string | null
  readonly freeText: string | null
  readonly issuedAt: string
  readonly calledAt?: string
  readonly servingStartedAt?: string
  readonly servedAt?: string
  readonly cancelledAt?: string
  readonly markedAt?: string
  readonly appointmentAt: string | null
  readonly checkedInAt: string | null
}

export type SlotEntry = {
  readonly date: string
  readonly bucketId: number
  readonly granularity: 15 | 30 | 60
  readonly capacity: number
  readonly taken: number
  readonly available: number
}

/**
 * Staff-only shape: PII (nameKana / phoneLast4 / freeText) のせ。
 * calling / serving / waitingPreview のすべてが full Ticket row を
 * carry。 `terminal` は ADR-0069 §Stage 11 で追加された直近 8 件の
 * Served / Cancelled / NoShow ticket スライス (履歴列の source)。
 * `x-staff-token` 付き GET /api/v1/queue で返る。 v4 で
 * `waitingPreview` の cap が外れ、 全 Waiting ticket を返す
 * (ADR-0071)。
 */
export type StaffShopState = {
  readonly v: 6
  readonly waitingCount: number
  readonly callableNowCount: number
  readonly laneCounts: LaneCounts
  readonly calling: readonly Ticket[]
  readonly serving: readonly Ticket[]
  readonly pendingNoShow: readonly Ticket[]
  readonly waitingPreview: readonly Ticket[]
  readonly terminal: readonly Ticket[]
  readonly nextReservationDeadline: string | null
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
  appointmentAt?: string
}): Promise<ApiResult<{ ticket: Ticket }>> =>
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

// ADR-0074 — customer 「遅れる」 response inside the PendingNoShow
// grace window. Reservation tickets reschedule to `now + etaMinutes`;
// walk-in / priority tickets are recalled to the lane head (etaMinutes
// is sent for audit symmetry but the server ignores it for non-
// reservation lanes).
export const acknowledgeLate = async (
  ticketId: string,
  body: { nameKana: string; phoneLast4: string; etaMinutes: 5 | 10 | 30 | 60 },
): Promise<ApiResult<{ ticket: Ticket }>> =>
  fetchJson(`${baseUrl()}/api/v1/tickets/${ticketId}/late-acknowledge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

// ADR-0074 — customer 「来ない」 response inside the PendingNoShow
// grace window. Equivalent to a customer-initiated cancel with a
// pre-set reason; defaults to "no-come" server-side when omitted.
export const confirmNoCome = async (
  ticketId: string,
  body: { nameKana: string; phoneLast4: string; reason?: string },
): Promise<ApiResult<{ ticket: Ticket }>> =>
  fetchJson(`${baseUrl()}/api/v1/tickets/${ticketId}/no-come-confirm`, {
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

/**
 * Exponential-backoff schedule for WebSocket reconnects. Capped at
 * 30s after a few quick attempts so a long network outage does not
 * spam the server, but **never gives up** — the customer who left
 * /ticket open on their phone overnight will still be connected
 * when staff calls them in the morning. The previous "give up after
 * 10 attempts" behaviour stranded idle tabs after ~36s of
 * connectivity trouble (or after a Cloudflare DO hibernation cycle
 * during a quiet shop hour); both are routine, not terminal.
 */
const reconnectDelayMs = (attempt: number): number => {
  if (attempt === 0) return 500
  if (attempt === 1) return 1000
  if (attempt === 2) return 2000
  if (attempt < 8) return 4000
  if (attempt < 16) return 10_000
  return 30_000
}

/**
 * Reconnecting WebSocket projection feed (C12). The handler owns:
 *
 *   - infinite exponential-backoff reconnect (0.5 / 1 / 2 / 4×5 /
 *     10×8 / 30 s) so a transient outage or a DO hibernation cycle
 *     never strands an idle tab.
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
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  // ADR-0075 — local mirror of the server's last broadcast snapshot.
  // Snapshots replace it; deltas are applied on top. The merged
  // ShopState surfaces through `onProjection` so consumers see the
  // same shape as before the v5 envelope landed.
  let localShopState: ShopState | null = null

  const setState = (next: QueueFeedState): void => {
    currentState = next
    callbacks.onState?.(next)
  }

  let keepaliveTimer: ReturnType<typeof setInterval> | undefined
  const KEEPALIVE_INTERVAL_MS = 30_000

  const stopKeepalive = (): void => {
    if (keepaliveTimer !== undefined) {
      clearInterval(keepaliveTimer)
      keepaliveTimer = undefined
    }
  }

  const connect = (): void => {
    socket = new WebSocket(`${wsUrl()}/api/v1/queue/feed`)
    socket.onopen = () => {
      attempt = 0
      setState("open")
      // Client-side keepalive: send an empty text frame every 30s.
      // The runtime's Hibernating WebSocket can otherwise idle-close
      // a quiet broadcast feed (no mutations during a slow hour);
      // the DO's `webSocketMessage` handler is a no-op so this is
      // safe traffic. The matching server-side `setWebSocketAuto
      // Response("ping" → "pong")` keeps the DO hibernated for these
      // frames so the ping doesn't cost an actor wake.
      stopKeepalive()
      keepaliveTimer = setInterval(() => {
        if (socket?.readyState === WebSocket.OPEN) {
          socket.send("ping")
        }
      }, KEEPALIVE_INTERVAL_MS)
    }
    socket.onmessage = (event: MessageEvent<string>) => {
      // The keepalive auto-response echoes "pong"; ignore those so
      // the projection handler only sees genuine state payloads.
      if (event.data === "pong") return
      try {
        const parsed: unknown = JSON.parse(event.data)
        // ADR-0081 v6 envelope: { v: 6, kind, at, capability, ... }.
        // Earlier envelopes (v4 / v5) are explicitly rejected — the
        // user spec waived backward compatibility for the lattice
        // overhaul.
        if (typeof parsed === "object" && parsed !== null && (parsed as { v?: unknown }).v === 6) {
          const env = parsed as
            | { v: 6; kind: "snapshot"; snapshot: ShopState }
            | { v: 6; kind: "delta"; delta: ShopStateDelta }
          if (env.kind === "snapshot") {
            localShopState = env.snapshot
            callbacks.onProjection(env.snapshot)
          } else if (localShopState !== null) {
            localShopState = applyShopStateDelta(localShopState, env.delta)
            callbacks.onProjection(localShopState)
          } else {
            // delta arrived before snapshot — request a fresh
            // snapshot via reconnect (cheaper than a separate REST
            // round-trip and keeps the same handshake path).
            socket?.close(1011, "delta-before-snapshot")
          }
          return
        }
        callbacks.onProjection(parsed)
      } catch (err) {
        callbacks.onError?.("ParseError", err)
      }
    }
    socket.onerror = (err) => {
      callbacks.onError?.("NetworkError", err)
    }
    socket.onclose = () => {
      stopKeepalive()
      // Manual close (= consumer unmounted): the page's onDestroy
      // has already reset wsStatus and may have moved on to another
      // route. Firing `onState("closed")` here would overwrite the
      // store value the new route just set; just exit silently.
      if (manualClose) return
      const delay = reconnectDelayMs(attempt)
      attempt += 1
      setState("reconnecting")
      reconnectTimer = setTimeout(connect, delay)
    }
  }

  connect()

  return {
    close: (): void => {
      manualClose = true
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer)
      stopKeepalive()
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
