import type { TraceId } from "@booking/core"
import type { Context, Next } from "hono"
import { currentTraceId, TRACE_ID_HEADER } from "./traceIdHeader.js"

/**
 * Per-request entry emitted on every API response. The shape
 * mirrors the rest of the structured-log surface (see
 * `WorkersLoggerLive`) so the operator dashboard can filter on
 * `_tag` / `code` without per-source regex.
 */
export type HttpRequestLog = {
  readonly method: string
  readonly path: string
  readonly status: number
  readonly ms: number
  readonly traceId: TraceId | null
}

/**
 * Test-only seam — the integration tests run inside the same
 * isolate as the middleware (`cloudflareTest`'s `main` worker), so
 * setting a module-level callback is enough to capture every
 * emitted entry without scraping the worker's stdio. Production
 * code never sets the tap; the conditional is a single null check.
 */
let tap: ((entry: HttpRequestLog) => void) | null = null
export const __setRequestLogTap = (next: ((entry: HttpRequestLog) => void) | null): void => {
  tap = next
}

/**
 * Hono middleware that emits a structured `http.request` log line
 * and attaches `X-Trace-Id` to the outgoing response.
 *
 * Mounted at the OUTERMOST layer so it observes the final status
 * (post `securityHeaders` / `corsAllowlist` rewrap) and the
 * wall-clock includes the time those middlewares add. Skips the
 * WebSocket 101 upgrade and other 1xx responses for the same
 * reason `securityHeaders` does — the `Response` constructor
 * refuses to rewrap them and would drop the `webSocket`
 * attachment.
 */
export const requestLog = async (c: Context, next: Next): Promise<void> => {
  const started = Date.now()
  const method = c.req.method
  const path = new URL(c.req.url).pathname

  await next()

  const status = c.res.status
  const ms = Date.now() - started
  const traceId = currentTraceId()
  const entry: HttpRequestLog = { method, path, status, ms, traceId }

  if (traceId !== null && status >= 200 && status < 600) {
    const original = c.res
    const headers = new Headers(original.headers)
    headers.set(TRACE_ID_HEADER, traceId)
    c.res = new Response(original.body, {
      status: original.status,
      statusText: original.statusText,
      headers,
    })
  }

  // biome-ignore lint/suspicious/noConsole: structured worker log sink (mirrors WorkersLoggerLive)
  console.info(
    JSON.stringify({
      _tag: "HttpRequest",
      code: "I_HTTP_REQUEST",
      severity: "infrastructure",
      method,
      path,
      status,
      ms,
      ...(traceId !== null ? { traceId } : {}),
    }),
  )

  if (tap !== null) tap(entry)
}
