/**
 * Shared HTTP helpers used by the ROUTES table (S16 / ADR-0084).
 *
 * Lives outside `router.ts` so each `RouteDescriptor` in
 * `routes.ts` can hand its handler a small, named utility set
 * (DO stub, dispatch-envelope mapper, fail-response builder,
 * staff capability guard) without dragging the Hono `app`
 * construction in scope.
 */
import type { QueueResult, QueueShop } from "../durableObjects/QueueShop.js"
import { verifyStaffJwt } from "../security/jwt.js"
import { readSessionCookie, verifySession } from "../security/session.js"
import { timingSafeEqual } from "../security/timingSafeEqual.js"
import { DEFECT_STATUS, statusForTag } from "./errorEnvelope.js"
import type { Env } from "./types.js"

export const stub = (env: Env): DurableObjectStub<QueueShop> =>
  env.QUEUE_SHOP.get(env.QUEUE_SHOP.idFromName("shop"))

export const dispatchEnvelope = (result: QueueResult, status = 200): Response => {
  if (result.ok) {
    const body =
      "tickets" in result
        ? { ok: true, tickets: result.tickets }
        : "ticket" in result
          ? {
              ok: true,
              ticket: result.ticket,
              ...(result.merged === true ? { merged: true } : {}),
            }
          : { ok: true }
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    })
  }
  return new Response(
    JSON.stringify({
      ok: false,
      error: { _tag: result.error._tag, code: result.error.code },
    }),
    {
      status:
        result.error._tag === "Defect" ? DEFECT_STATUS : statusForTag(result.error._tag as never),
      headers: { "content-type": "application/json; charset=utf-8" },
    },
  )
}

export const failResponse = (
  status: number,
  _tag: string,
  code: string,
  extra: Record<string, unknown> = {},
): Response =>
  new Response(JSON.stringify({ ok: false, error: { _tag, code, ...extra } }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  })

export const okJson = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  })

/**
 * Staff capability guard — accepts three credential surfaces:
 *
 *   1. `x-staff-token: <secret>` header. Legacy shape kept for
 *      curl scripts + the local-dev workflow; constant-time
 *      compared with `STAFF_SESSION_SECRET` (ADR-0058).
 *   2. `Authorization: Bearer <jwt>` header. HS256 JWT issued
 *      by `POST /api/v1/staff/login`; verified through
 *      `jose.jwtVerify` (ADR-0055 follow-up).
 *   3. `Cookie: __Host-staff_session=<token>`. HMAC-signed
 *      cookie issued by the same login endpoint; verified
 *      through `verifySession` which itself folds the MAC
 *      check through `timingSafeEqual`.
 *
 * Any one of the three is sufficient. Failures uniformly return
 * 401 + `MissingStaffCapability` so an attacker cannot
 * distinguish "wrong header form" from "expired JWT" from
 * "wrong cookie sig".
 */
export const requireStaff = async (c: {
  req: { header: (k: string) => string | undefined }
  env: Env
}): Promise<{ ok: true } | { ok: false; res: Response }> => {
  const secret = c.env.STAFF_SESSION_SECRET
  if (secret === undefined || secret === "") {
    return {
      ok: false,
      res: failResponse(503, "MissingStaffCapability", "E_VAL_MISSING_STAFF_CAPABILITY", {
        reason: "absent",
      }),
    }
  }
  const headerToken = c.req.header("x-staff-token")
  if (headerToken !== undefined && timingSafeEqual(headerToken, secret)) {
    return { ok: true }
  }
  const auth = c.req.header("authorization")
  if (auth?.startsWith("Bearer ") === true) {
    const jwt = auth.slice("Bearer ".length).trim()
    if (jwt.length > 0) {
      const result = await verifyStaffJwt(secret, jwt)
      if (result.ok) return { ok: true }
    }
  }
  const cookieValue = readSessionCookie(c.req.header("cookie"))
  if (cookieValue !== null) {
    const result = await verifySession(secret, cookieValue)
    if (result.ok) return { ok: true }
  }
  return {
    ok: false,
    res: failResponse(401, "MissingStaffCapability", "E_VAL_MISSING_STAFF_CAPABILITY", {
      reason:
        headerToken === undefined && auth === undefined && cookieValue === null
          ? "absent"
          : "wrong_kind",
    }),
  }
}
