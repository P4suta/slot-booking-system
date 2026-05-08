import type { Context } from "hono"
import { DEFECT_STATUS, logHttpEnvelope } from "./errorEnvelope.js"

/**
 * `app.onError` handler — catches any uncaught throw inside a
 * route handler. Domain errors flow through `dispatchEnvelope` /
 * `failResponse` and never reach here; what does is a programmer
 * error (`TypeError`, `RangeError`, an Effect `Defect`, etc.) that
 * we want to:
 *
 *   1. Surface as a uniform `{ ok: false, error: { _tag: "Defect",
 *      code: "E_DEFECT" } }` envelope so the client never sees a
 *      stack trace or the runtime's default 500 page.
 *   2. Log with the structured `HttpEnvelope` shape (`errorTag`,
 *      `status`, `path`, `traceId`) plus the underlying `message`
 *      so the operator dashboard can pivot from a customer-
 *      reported failure to the throwing call site.
 */
export const onError = (err: Error, c: Context): Response => {
  const path = new URL(c.req.url).pathname
  logHttpEnvelope({
    errorTag: "Defect",
    errorCode: "E_DEFECT",
    status: DEFECT_STATUS,
    path,
    method: c.req.method,
    message: err.message,
  })
  return new Response(JSON.stringify({ ok: false, error: { _tag: "Defect", code: "E_DEFECT" } }), {
    status: DEFECT_STATUS,
    headers: { "content-type": "application/json; charset=utf-8" },
  })
}
