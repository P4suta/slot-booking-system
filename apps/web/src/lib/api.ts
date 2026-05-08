import { apiBaseUrl } from "./baseUrl.js"

const baseUrl = apiBaseUrl

export type ErrorEnvelope = {
  readonly _tag: string
  readonly code: string
  readonly reason?: string
}

export type Ticket = {
  readonly id: string
  readonly seq: number
  readonly state: "Waiting" | "Called" | "Served" | "NoShow" | "Cancelled"
  readonly nameKana: string | null
  readonly phoneLast4: string | null
  readonly freeText: string | null
  readonly issuedAt: string
  readonly calledAt?: string
  readonly servedAt?: string
  readonly cancelledAt?: string
  readonly markedAt?: string
}

export type ShopState = {
  readonly waitingCount: number
  readonly serving: Ticket | null
  readonly waitingPreview: ReadonlyArray<{ id: string; seq: number }>
}

/**
 * Staff-only shape: PII (nameKana / phoneLast4 / freeText) のせ。
 * `x-staff-token` を付けて GET /api/v1/queue を叩いたときに返る形。
 * 顧客 landing で使う {@link ShopState} のスーパーセット。
 */
export type StaffShopState = {
  readonly waitingCount: number
  readonly serving: Ticket | null
  readonly waitingPreview: readonly Ticket[]
}

export type ApiResult<A> = { ok: true; value: A } | { ok: false; error: ErrorEnvelope }

const json = async <A>(res: Response): Promise<ApiResult<A>> => {
  const body = (await res.json().catch(() => null)) as { ok: boolean; error?: ErrorEnvelope }
  if (res.ok && body?.ok === true) return { ok: true, value: body as unknown as A }
  return {
    ok: false,
    error: body?.error ?? { _tag: "Network", code: `E_NET_${res.status}` },
  }
}

export const issueTicket = async (input: {
  nameKana: string
  phoneLast4: string
  freeText: string | null
}): Promise<ApiResult<{ ticket: Ticket }>> => {
  const res = await fetch(`${baseUrl()}/api/v1/tickets`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  })
  return json(res)
}

export const myTicket = async (input: {
  ticketId: string
  nameKana: string
  phoneLast4: string
}): Promise<ApiResult<{ ticket: Ticket }>> => {
  const params = new URLSearchParams(input)
  const res = await fetch(`${baseUrl()}/api/v1/tickets/me?${params}`)
  return json(res)
}

export const cancelTicket = async (
  ticketId: string,
  body: { nameKana: string; phoneLast4: string; reason: string },
): Promise<ApiResult<{ ticket: Ticket }>> => {
  const res = await fetch(`${baseUrl()}/api/v1/tickets/${ticketId}/cancel`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  return json(res)
}

export const shopState = async (): Promise<ApiResult<ShopState>> => {
  const res = await fetch(`${baseUrl()}/api/v1/queue`)
  return json(res)
}

/**
 * Staff 権限版 shopState — preview に PII (kana / 末尾4 / freeText) が
 * 同梱される。 token を付けたまま public endpoint を叩くだけで sub-path
 * は変わらない (worker 側で `x-staff-token` をチェックして branch)。
 */
export const staffShopState = async (token: string): Promise<ApiResult<StaffShopState>> => {
  const res = await fetch(`${baseUrl()}/api/v1/queue`, {
    headers: { "x-staff-token": token },
  })
  return json(res)
}

/** Connect to the SSE projection feed. The caller closes the source. */
export const queueEventSource = (): EventSource =>
  new EventSource(`${baseUrl()}/api/v1/queue/events`)

/* -------------------------------------------------------------------------- */
/* Staff actions — protected by x-staff-token.                                */
/* -------------------------------------------------------------------------- */

const staffHeaders = (token: string) => ({
  "content-type": "application/json",
  "x-staff-token": token,
})

export const callNext = async (token: string): Promise<ApiResult<{ ticket: Ticket }>> => {
  const res = await fetch(`${baseUrl()}/api/v1/queue/call-next`, {
    method: "POST",
    headers: staffHeaders(token),
  })
  return json(res)
}

export const markServed = async (
  token: string,
  ticketId: string,
): Promise<ApiResult<{ ticket: Ticket }>> => {
  const res = await fetch(`${baseUrl()}/api/v1/tickets/${ticketId}/served`, {
    method: "POST",
    headers: staffHeaders(token),
  })
  return json(res)
}

export const markNoShow = async (
  token: string,
  ticketId: string,
): Promise<ApiResult<{ ticket: Ticket }>> => {
  const res = await fetch(`${baseUrl()}/api/v1/tickets/${ticketId}/no-show`, {
    method: "POST",
    headers: staffHeaders(token),
  })
  return json(res)
}

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
): Promise<ApiResult<{ ticket: Ticket }>> => {
  const res = await fetch(`${baseUrl()}/api/v1/tickets/${ticketId}/recall`, {
    method: "POST",
    headers: staffHeaders(token),
  })
  return json(res)
}

export const staffCancel = async (
  token: string,
  ticketId: string,
  reason: string,
): Promise<ApiResult<{ ticket: Ticket }>> => {
  const res = await fetch(`${baseUrl()}/api/v1/tickets/${ticketId}/cancel`, {
    method: "POST",
    headers: staffHeaders(token),
    body: JSON.stringify({ reason }),
  })
  return json(res)
}
