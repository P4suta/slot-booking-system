import { Result, Schema } from "effect"
import type { Context } from "hono"
import { signStaffJwt } from "../../security/jwt.js"
import { sessionCookieHeader, signSession } from "../../security/session.js"
import { timingSafeEqual } from "../../security/timingSafeEqual.js"
import { parseJsonBody } from "../parseJsonBody.js"
import type { Env } from "../types.js"

/**
 * `POST /api/v1/staff/login` — exchange the shared `password`
 * (the deployment's `STAFF_SESSION_SECRET`) for two surfaces:
 *
 *   1. A short-lived HS256 JWT in the JSON response body. API
 *      consumers (curl scripts, the staff dashboard's REST
 *      calls) carry it as `Authorization: Bearer <token>`.
 *   2. An HMAC-signed `__Host-staff_session` cookie attached to
 *      the response (HttpOnly, Secure, SameSite=Strict, Path=/).
 *      Browsers send it on every same-origin request, which
 *      lets the staff dashboard re-authenticate after a refresh
 *      without re-prompting for the password.
 *
 * Both surfaces share the same TTL (8 h by default — long
 * enough for a single shift, short enough that an exfiltrated
 * cookie does not survive overnight).
 */

const LoginBodySchema = Schema.Struct({ password: Schema.String })

const TTL_SECONDS = 8 * 60 * 60

const failResponse = (
  status: number,
  _tag: string,
  code: string,
  extra: Record<string, unknown> = {},
): Response =>
  new Response(JSON.stringify({ ok: false, error: { _tag, code, ...extra } }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  })

export const handleStaffLogin = async (c: Context<{ Bindings: Env }>): Promise<Response> => {
  const secret = c.env.STAFF_SESSION_SECRET
  if (secret === undefined || secret === "") {
    return failResponse(503, "MissingStaffCapability", "E_VAL_MISSING_STAFF_CAPABILITY")
  }
  const parsed = await parseJsonBody(c)
  if (!parsed.ok) {
    return failResponse(parsed.status, parsed.tag, parsed.code, { reason: parsed.reason })
  }
  const decoded = Schema.decodeUnknownResult(LoginBodySchema)(parsed.raw)
  if (Result.isFailure(decoded)) {
    return failResponse(422, "InvalidBody", "E_VAL_BODY")
  }
  if (!timingSafeEqual(decoded.success.password, secret)) {
    // Constant-time compare with the deployment secret. The
    // 401 + reason="wrong_kind" payload mirrors the pattern the
    // existing requireStaff guard returns, so a presented-but-
    // wrong token surfaces the same envelope.
    return failResponse(401, "MissingStaffCapability", "E_VAL_MISSING_STAFF_CAPABILITY")
  }
  const jwt = await signStaffJwt(secret, TTL_SECONDS)
  const cookie = await signSession(secret, {
    sub: "staff",
    exp: Date.now() + TTL_SECONDS * 1000,
    capabilities: ["operate-queue"],
  })
  return new Response(
    JSON.stringify({
      ok: true,
      token: jwt,
      expiresIn: TTL_SECONDS,
    }),
    {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "set-cookie": sessionCookieHeader(cookie, TTL_SECONDS),
      },
    },
  )
}
