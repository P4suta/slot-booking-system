import { jwtVerify, SignJWT } from "jose"

/**
 * HS256 JWT helpers for the staff-session token. The signing key
 * is `STAFF_SESSION_SECRET` (UTF-8 → bytes) shared with the
 * `requireStaff` guard's constant-time comparator (ADR-0058);
 * `jose` runs entirely on Workers' WebCrypto so the worker
 * bundle stays free of node:crypto.
 *
 * Payload shape:
 *   `{ sub: "staff", capabilities: ["operate-queue"], exp, iat }`
 *
 * `exp` is an absolute epoch-second timestamp; the verifier
 * rejects past `exp` with a thrown `JWTExpired`. The capability
 * array is reserved for future capability granularity (currently
 * the staff role is binary).
 */

const ISSUER = "queue.staff"
const AUDIENCE = "queue.api"

export type StaffJwtPayload = {
  readonly sub: "staff"
  readonly capabilities: readonly string[]
  /** Absolute expiry, epoch seconds. */
  readonly exp: number
  /** Issued at, epoch seconds. */
  readonly iat: number
}

const encodeSecret = (secret: string): Uint8Array => new TextEncoder().encode(secret)

export const signStaffJwt = async (
  secret: string,
  ttlSeconds: number,
  capabilities: readonly string[] = ["operate-queue"],
): Promise<string> => {
  const key = encodeSecret(secret)
  return new SignJWT({ capabilities })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject("staff")
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${String(ttlSeconds)}s`)
    .sign(key)
}

export const verifyStaffJwt = async (
  secret: string,
  token: string,
): Promise<{ ok: true; payload: StaffJwtPayload } | { ok: false; reason: string }> => {
  try {
    const key = encodeSecret(secret)
    const { payload } = await jwtVerify(token, key, {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ["HS256"],
    })
    if (payload.sub !== "staff") return { ok: false, reason: "wrong_subject" }
    const exp = typeof payload.exp === "number" ? payload.exp : 0
    const iat = typeof payload.iat === "number" ? payload.iat : 0
    const caps = Array.isArray(payload.capabilities)
      ? payload.capabilities.filter((c): c is string => typeof c === "string")
      : []
    return {
      ok: true,
      payload: { sub: "staff", capabilities: caps, exp, iat },
    }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.name : "verify_error" }
  }
}
