import { buildRequest } from "./httpFixture.js"

/**
 * Typed request builders for every Hono-mounted endpoint. Each
 * builder accepts the variant inputs (handle, ticketId, body fields)
 * + optional staff auth headers and returns a fully-formed Request
 * the integration tests dispatch via `worker().fetch`.
 *
 * The builders intentionally do NOT validate inputs — that's the
 * router's job, and the integration tests want to exercise both
 * the happy path and the malformed-input rejection path. Tests
 * pass values that look like the real wire shape and assert the
 * server's response.
 */

export type Handle = {
  readonly nameKana: string
  readonly phoneLast4: string
}

export const issueTicket = (
  body: { handle: Handle; freeText: string | null },
  init: { readonly headers?: Record<string, string> } = {},
) =>
  buildRequest("/api/v1/tickets", {
    method: "POST",
    headers: { "content-type": "application/json", ...init.headers },
    body: JSON.stringify({
      nameKana: body.handle.nameKana,
      phoneLast4: body.handle.phoneLast4,
      freeText: body.freeText,
    }),
  })

export const myTicket = (query: { ticketId: string; nameKana: string; phoneLast4: string }) => {
  const params = new URLSearchParams(query)
  return buildRequest(`/api/v1/tickets/me?${params.toString()}`)
}

export const cancelTicket = (ticketId: string, body: { handle: Handle; reason: string }) =>
  buildRequest(`/api/v1/tickets/${ticketId}/cancel`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      nameKana: body.handle.nameKana,
      phoneLast4: body.handle.phoneLast4,
      reason: body.reason,
    }),
  })

export const staffCancel = (
  ticketId: string,
  reason: string,
  staffHeaders: Record<string, string>,
) =>
  buildRequest(`/api/v1/tickets/${ticketId}/cancel`, {
    method: "POST",
    headers: { "content-type": "application/json", ...staffHeaders },
    body: JSON.stringify({ reason }),
  })

export const callNext = (staffHeaders: Record<string, string>) =>
  buildRequest("/api/v1/queue/call-next", {
    method: "POST",
    headers: staffHeaders,
  })

export const markServed = (ticketId: string, staffHeaders: Record<string, string>) =>
  buildRequest(`/api/v1/tickets/${ticketId}/served`, {
    method: "POST",
    headers: staffHeaders,
  })

export const markNoShow = (ticketId: string, staffHeaders: Record<string, string>) =>
  buildRequest(`/api/v1/tickets/${ticketId}/no-show`, {
    method: "POST",
    headers: staffHeaders,
  })

export const recall = (ticketId: string, staffHeaders: Record<string, string>) =>
  buildRequest(`/api/v1/tickets/${ticketId}/recall`, {
    method: "POST",
    headers: staffHeaders,
  })

export const queueProjection = (extraHeaders: Record<string, string> = {}) =>
  buildRequest("/api/v1/queue", { headers: extraHeaders })

export const openApiDocument = () => buildRequest("/api/v1/openapi.json")

export const staffLogin = (password: string) =>
  buildRequest("/api/v1/staff/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  })

export const queueFeedUpgrade = () => buildRequest("/api/v1/queue/feed", { upgrade: true })
