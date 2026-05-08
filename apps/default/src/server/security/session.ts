import { timingSafeEqual } from "./timingSafeEqual.js"

/**
 * HMAC-signed cookie session for the staff dashboard. The cookie
 * is served as `__Host-staff_session=<base64url(payload)>.<sig>`
 * with `HttpOnly; Secure; SameSite=Strict; Path=/` so a
 * cross-origin attacker cannot exfiltrate it and a stale
 * subdomain cannot read it. The `__Host-` prefix is the
 * RFC 6265bis-2 directive that browsers enforce these properties
 * on the cookie name itself.
 *
 * Payload is a JSON object signed with HS256 over WebCrypto
 * (`crypto.subtle.sign`); verification folds the recomputed MAC
 * through `timingSafeEqual` (ADR-0058) so a cookie that mostly
 * matches the expected MAC does not leak its prefix.
 */

const COOKIE_NAME = "__Host-staff_session"
const COOKIE_PATH = "/"

export type SessionPayload = {
  readonly sub: "staff"
  /** Absolute expiry, epoch milliseconds. */
  readonly exp: number
  /** Capabilities granted at issue time. */
  readonly capabilities: readonly string[]
}

const b64urlEncode = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")

const b64urlDecode = (s: string): Uint8Array => {
  const padded = `${s.replace(/-/g, "+").replace(/_/g, "/")}===`
  const trimmed = padded.slice(0, padded.length - (padded.length % 4))
  const raw = atob(trimmed)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i)
  return out
}

const importHmacKey = async (secret: string): Promise<CryptoKey> =>
  crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  )

export const signSession = async (secret: string, payload: SessionPayload): Promise<string> => {
  const key = await importHmacKey(secret)
  const body = b64urlEncode(new TextEncoder().encode(JSON.stringify(payload)))
  const sigBytes = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)),
  )
  const sig = b64urlEncode(sigBytes)
  return `${body}.${sig}`
}

export const verifySession = async (
  secret: string,
  cookie: string,
): Promise<{ ok: true; payload: SessionPayload } | { ok: false; reason: string }> => {
  const dot = cookie.lastIndexOf(".")
  if (dot < 1) return { ok: false, reason: "malformed" }
  const body = cookie.slice(0, dot)
  const presentedSig = cookie.slice(dot + 1)
  const key = await importHmacKey(secret)
  const expectedSigBytes = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)),
  )
  const expectedSig = b64urlEncode(expectedSigBytes)
  if (!timingSafeEqual(presentedSig, expectedSig)) {
    return { ok: false, reason: "bad_signature" }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(b64urlDecode(body)))
  } catch {
    return { ok: false, reason: "malformed_payload" }
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, reason: "malformed_payload" }
  }
  const p = parsed as { sub?: unknown; exp?: unknown; capabilities?: unknown }
  if (p.sub !== "staff" || typeof p.exp !== "number") {
    return { ok: false, reason: "malformed_payload" }
  }
  if (Date.now() > p.exp) return { ok: false, reason: "expired" }
  const caps = Array.isArray(p.capabilities)
    ? p.capabilities.filter((c): c is string => typeof c === "string")
    : []
  return { ok: true, payload: { sub: "staff", exp: p.exp, capabilities: caps } }
}

export const sessionCookieHeader = (token: string, ttlSeconds: number): string =>
  [
    `${COOKIE_NAME}=${token}`,
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    `Path=${COOKIE_PATH}`,
    `Max-Age=${String(ttlSeconds)}`,
  ].join("; ")

export const sessionCookieClearHeader = (): string =>
  [
    `${COOKIE_NAME}=`,
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    `Path=${COOKIE_PATH}`,
    "Max-Age=0",
  ].join("; ")

export const readSessionCookie = (cookieHeader: string | undefined): string | null => {
  if (cookieHeader === undefined) return null
  for (const segment of cookieHeader.split(";")) {
    const [name, ...rest] = segment.trim().split("=")
    if (name === COOKIE_NAME) {
      const value = rest.join("=")
      return value.length > 0 ? value : null
    }
  }
  return null
}
