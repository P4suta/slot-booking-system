import { Result, Schema } from "effect"
import type { Context } from "hono"
import { signStaffJwt } from "../../security/jwt.js"
import { sessionCookieHeader, signSession } from "../../security/session.js"
import { timingSafeEqual } from "../../security/timingSafeEqual.js"
import { failResponse } from "../_shared.js"
import { DEBUG_PREVIEW_CHARS, type DebugEnvelope } from "../errorEnvelope.js"
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
 *
 * Stage 21 / ADR-0089 — the 401 password-mismatch envelope is
 * enriched with a {@link DebugEnvelope} in dev mode so the
 * operator can tell "wrong length" (typo) from "right length,
 * wrong bytes" (whitespace / case-folding / pasted from the
 * wrong line). The wire shape in production (`IS_DEV !== "1"`)
 * is byte-for-byte the same as before — no debug field leaks.
 */

const LoginBodySchema = Schema.Struct({ password: Schema.String })

const TTL_SECONDS = 8 * 60 * 60

export const handleStaffLogin = async (c: Context<{ Bindings: Env }>): Promise<Response> => {
  const secret = c.env.STAFF_SESSION_SECRET
  if (secret === undefined || secret === "") {
    return failResponse(503, "MissingStaffCapability", "E_VAL_MISSING_STAFF_CAPABILITY", {
      debug: {
        reason: "secret_missing",
        hint: "Deployment is missing STAFF_SESSION_SECRET — set it in .dev.vars (dev) or via `wrangler secret put` (prod)",
      },
      env: c.env,
    })
  }
  const parsed = await parseJsonBody(c)
  if (!parsed.ok) {
    return failResponse(parsed.status, parsed.tag, parsed.code, {
      extra: { reason: parsed.reason },
      debug: {
        reason: "json_parse_failure",
        hint: "Request body is not parseable JSON — check Content-Type: application/json and JSON syntax",
      },
      env: c.env,
    })
  }
  const decoded = Schema.decodeUnknownResult(LoginBodySchema)(parsed.raw)
  if (Result.isFailure(decoded)) {
    return failResponse(422, "InvalidBody", "E_VAL_BODY", {
      debug: {
        reason: "login_body_decode_failure",
        field: "password",
        hint: 'Login body must be `{ "password": <string> }`',
      },
      env: c.env,
    })
  }
  if (!timingSafeEqual(decoded.success.password, secret)) {
    // Constant-time compare with the deployment secret. The wire
    // envelope is the same 401 + MissingStaffCapability everywhere;
    // the dev-mode `debug` field distinguishes "you typed too few
    // characters" from "you typed the right length but the wrong
    // bytes" so the operator can recover the right secret without
    // shouting it across the room.
    const pwd = decoded.success.password
    const debug: DebugEnvelope = {
      reason: pwd.length !== secret.length ? "password_length_mismatch" : "password_value_mismatch",
      receivedLen: pwd.length,
      expectedLen: secret.length,
      receivedHead: pwd.slice(0, DEBUG_PREVIEW_CHARS),
      receivedTail: pwd.slice(-DEBUG_PREVIEW_CHARS),
      hint: "Verify .dev.vars STAFF_SESSION_SECRET matches the value typed into the form",
    }
    return failResponse(401, "MissingStaffCapability", "E_VAL_MISSING_STAFF_CAPABILITY", {
      debug,
      env: c.env,
    })
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
