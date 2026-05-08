import type { Context } from "hono"

/**
 * Result of attempting to parse the request body as JSON. The
 * three concrete shapes give the route handler enough
 * information to map straight to a `failResponse` without
 * branching on `try`/`catch` at every call site:
 *
 *   - `{ ok: true, raw }` → schema-validate `raw` next.
 *   - `{ ok: false, status: 400, tag: "InvalidPayload", … }`
 *     → the body wasn't JSON at all (e.g. `application/json`
 *     with a stray `}`). Surfacing this as a distinct 400 from
 *     422 `InvalidBody` lets operators tell "client sent bytes
 *     we couldn't even parse" from "client sent JSON that
 *     didn't match the schema" in the structured log.
 */
export type JsonBodyResult =
  | { readonly ok: true; readonly raw: unknown }
  | {
      readonly ok: false
      readonly status: 400
      readonly tag: "InvalidPayload"
      readonly code: "E_VAL_PAYLOAD"
      readonly reason: string
    }

export const parseJsonBody = async (c: Context): Promise<JsonBodyResult> => {
  try {
    const raw: unknown = await c.req.json()
    return { ok: true, raw }
  } catch (err) {
    const reason = err instanceof Error ? err.message : "non-json body"
    return {
      ok: false,
      status: 400,
      tag: "InvalidPayload",
      code: "E_VAL_PAYLOAD",
      reason,
    }
  }
}
