import { signStaffJwt } from "../../../src/server/security/jwt.js"
import { sessionCookieHeader, signSession } from "../../../src/server/security/session.js"

/**
 * Auth fixture — issues a valid Bearer + cookie pair using the
 * test-runtime `STAFF_SESSION_SECRET` from wrangler.toml's
 * `[vars]` (or `.dev.vars` if Miniflare picks it up). Tests that
 * need staff capability call `staffHeaders()` and merge the
 * result into their request headers.
 *
 * The fixture intentionally calls the same `signStaffJwt` /
 * `signSession` the production login handler uses, so any
 * regression in the signing path surfaces in both the unit
 * tests (which test crypto in isolation) and the integration
 * tests (which test the wire envelope).
 */

const TTL_SECONDS = 8 * 60 * 60

export type StaffAuth = {
  readonly bearer: string
  readonly cookie: string
  /** Pre-built header object suitable for `new Headers(staffHeaders(secret).bearer)`. */
  readonly bearerHeaders: Record<string, string>
  readonly cookieHeaders: Record<string, string>
  readonly tokenHeaders: Record<string, string>
}

export const staffHeaders = async (secret: string): Promise<StaffAuth> => {
  const bearer = await signStaffJwt(secret, TTL_SECONDS)
  const cookie = await signSession(secret, {
    sub: "staff",
    exp: Date.now() + TTL_SECONDS * 1000,
    capabilities: ["operate-queue"],
  })
  return {
    bearer,
    cookie,
    bearerHeaders: { authorization: `Bearer ${bearer}` },
    cookieHeaders: { cookie: sessionCookieHeader(cookie, TTL_SECONDS) },
    // The legacy header path — accepted by requireStaff via
    // timingSafeEqual — for tests that assert all three credential
    // surfaces are honoured.
    tokenHeaders: { "x-staff-token": secret },
  }
}
