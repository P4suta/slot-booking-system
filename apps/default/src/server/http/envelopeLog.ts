import type { Context, Next } from "hono"
import { logHttpEnvelope } from "./errorEnvelope.js"

/**
 * Inspect every JSON response and, when it carries the
 * `{ ok: false, error: { _tag, code } }` envelope shape, emit a
 * structured `HttpEnvelope` log line. The route bodies stay thin
 * — the middleware folds the cross-cutting "every error response
 * is observable" concern into one place.
 *
 * Mounted INSIDE `securityHeaders` / `corsAllowlist` so it sees
 * the raw route response before those wrappers add their headers.
 * Body is consumed via `Response.clone()` so the original body
 * forwards downstream untouched.
 */
export const envelopeLog = async (c: Context, next: Next): Promise<void> => {
  await next()
  const status = c.res.status
  if (status < 400) return
  const ct = c.res.headers.get("content-type") ?? ""
  if (!ct.includes("json")) return
  const cloned = c.res.clone()
  let body: unknown
  try {
    body = await cloned.json()
  } catch {
    return
  }
  if (typeof body !== "object" || body === null) return
  const error = (body as { error?: unknown }).error
  if (typeof error !== "object" || error === null) return
  const tagRaw = (error as { _tag?: unknown })._tag
  const codeRaw = (error as { code?: unknown }).code
  if (typeof tagRaw !== "string") return
  const errorTag = tagRaw
  const code = typeof codeRaw === "string" ? codeRaw : ""
  logHttpEnvelope({
    errorTag,
    errorCode: code,
    status,
    path: new URL(c.req.url).pathname,
    method: c.req.method,
  })
}
