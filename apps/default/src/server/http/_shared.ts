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
import { DEFECT_STATUS, type DebugEnvelope, isDevMode, statusForTag } from "./errorEnvelope.js"
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
  options: {
    readonly extra?: Record<string, unknown>
    readonly debug?: DebugEnvelope
    readonly env?: { readonly IS_DEV?: string }
  } = {},
): Response => {
  const error: Record<string, unknown> = { _tag, code, ...(options.extra ?? {}) }
  if (options.debug !== undefined && options.env !== undefined && isDevMode(options.env)) {
    error.debug = options.debug
  }
  return new Response(JSON.stringify({ ok: false, error }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  })
}

export const okJson = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  })

/**
 * Discriminated failure surface for {@link requireStaff} — Stage 21
 * / ADR-0089. The wire envelope still uniformly returns 401 +
 * `MissingStaffCapability` (so an attacker cannot distinguish
 * "wrong header form" from "expired JWT" from "wrong cookie sig"
 * via the public response), but in dev mode the `debug.reason`
 * field carries this tag so the operator can tell at a glance
 * which credential surface failed and why. Closed enum — every new
 * failure shape must add a case here, and every consumer (tests,
 * the boundary log) must update its exhaustive switch.
 *
 *   - `secret_missing`     — server side: STAFF_SESSION_SECRET unset
 *   - `credential_absent`  — no header, bearer, or cookie presented
 *   - `header_mismatch`    — x-staff-token presented but ≠ secret
 *   - `bearer_malformed`   — Authorization present but not `Bearer X`
 *   - `bearer_invalid`     — Bearer JWT failed jose verification
 *   - `cookie_invalid`     — session cookie HMAC / payload bad
 */
export type StaffGuardFailureReason =
  | "secret_missing"
  | "credential_absent"
  | "header_mismatch"
  | "bearer_malformed"
  | "bearer_invalid"
  | "cookie_invalid"

/**
 * Helper for the {@link requireStaff} failure path. Wraps the 401
 * envelope into the discriminated `{ ok: false }` shape callers
 * pattern-match on and attaches the dev-mode `debug` context.
 */
const failStaff = (
  status: number,
  reason: StaffGuardFailureReason,
  env: { readonly IS_DEV?: string },
  hint: string,
): { ok: false; reason: StaffGuardFailureReason; res: Response } => ({
  ok: false,
  reason,
  res: failResponse(status, "MissingStaffCapability", "E_VAL_MISSING_STAFF_CAPABILITY", {
    debug: { reason, hint },
    env,
  }),
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
 * 401 + `MissingStaffCapability` on the wire so an attacker cannot
 * distinguish "wrong header form" from "expired JWT" from "wrong
 * cookie sig"; the dev-mode `debug.reason` field (Stage 21 /
 * ADR-0089) carries a {@link StaffGuardFailureReason} discriminant
 * for the operator. On success the result reports `via` so the
 * caller can log which surface was honoured.
 */
export const requireStaff = async (
  c: {
    req: { header: (k: string) => string | undefined }
    env: { readonly STAFF_SESSION_SECRET?: string; readonly IS_DEV?: string }
  },
  env: { readonly IS_DEV?: string } = c.env,
): Promise<
  | { ok: true; via: "header" | "bearer" | "cookie" }
  | { ok: false; reason: StaffGuardFailureReason; res: Response }
> => {
  const secret = c.env.STAFF_SESSION_SECRET
  if (secret === undefined || secret === "") {
    return failStaff(
      503,
      "secret_missing",
      env,
      "Deployment is missing STAFF_SESSION_SECRET — set it in .dev.vars (dev) or via `wrangler secret put` (prod)",
    )
  }
  // Track the deepest credential surface attempted so the failure
  // path can report the right reason. The three paths are tried in
  // declared order; the first to succeed short-circuits via the
  // happy returns below.
  const headerToken = c.req.header("x-staff-token")
  if (headerToken !== undefined) {
    if (timingSafeEqual(headerToken, secret)) {
      return { ok: true, via: "header" }
    }
    // header presented + did not match — record and continue, the
    // caller may also be carrying a valid bearer / cookie.
  }
  const auth = c.req.header("authorization")
  let bearerOutcome: "absent" | "malformed" | "invalid" | "valid" = "absent"
  if (auth !== undefined) {
    if (!auth.startsWith("Bearer ")) {
      bearerOutcome = "malformed"
    } else {
      const jwt = auth.slice("Bearer ".length).trim()
      if (jwt.length === 0) {
        bearerOutcome = "malformed"
      } else {
        const result = await verifyStaffJwt(secret, jwt)
        if (result.ok) return { ok: true, via: "bearer" }
        bearerOutcome = "invalid"
      }
    }
  }
  const cookieValue = readSessionCookie(c.req.header("cookie"))
  let cookieOutcome: "absent" | "invalid" | "valid" = "absent"
  if (cookieValue !== null) {
    const result = await verifySession(secret, cookieValue)
    if (result.ok) return { ok: true, via: "cookie" }
    cookieOutcome = "invalid"
  }
  // Reason precedence — most specific (most-progress-made) wins.
  // The cookie path is checked last; if a cookie was presented but
  // failed, that is the most informative signal. Otherwise a
  // presented-but-bad bearer beats a malformed Authorization header
  // beats a wrong x-staff-token beats outright absence.
  const reason: StaffGuardFailureReason =
    cookieOutcome === "invalid"
      ? "cookie_invalid"
      : bearerOutcome === "invalid"
        ? "bearer_invalid"
        : bearerOutcome === "malformed"
          ? "bearer_malformed"
          : headerToken !== undefined
            ? "header_mismatch"
            : "credential_absent"
  return failStaff(
    401,
    reason,
    env,
    reason === "credential_absent"
      ? "Attach x-staff-token, Authorization: Bearer <jwt>, or the __Host-staff_session cookie"
      : reason === "header_mismatch"
        ? "x-staff-token does not match STAFF_SESSION_SECRET — confirm the .dev.vars value"
        : reason === "bearer_malformed"
          ? "Authorization header is not `Bearer <jwt>` — check for typos / empty token"
          : reason === "bearer_invalid"
            ? "Bearer JWT failed verification (expired, wrong signature, or wrong issuer/audience)"
            : "Session cookie HMAC verification failed (tampered, expired, or signed with a rotated secret)",
  )
}
