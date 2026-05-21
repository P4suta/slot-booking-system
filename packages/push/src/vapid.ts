import { base64UrlToBytes, bytesToBase64Url, stringToBytes } from "./base64url.js"

/**
 * VAPID ([RFC 8292](https://datatracker.ietf.org/doc/html/rfc8292))
 * `ES256` JWT signer running on the Cloudflare Workers WebCrypto
 * surface. The JWT is sent to push services in the
 * `Authorization: vapid t=<JWT>, k=<vapidPublicKey>` header so the
 * push service can attribute deliveries to this origin.
 *
 * Inputs:
 *   - `audience`: the origin of the push subscription endpoint
 *     (e.g. `https://fcm.googleapis.com`). NOT the full endpoint
 *     URL — only the `scheme://host` part.
 *   - `subject`: contact URI per RFC 8292 §2.1 (`mailto:` or
 *     `https://`). Push services use this if they need to reach
 *     the operator about delivery issues.
 *   - `privateKeyBase64Url`: 32-byte raw P-256 scalar, URL-safe
 *     base64 (no padding).
 *   - `expirySeconds`: clamp to ≤ 24 h per RFC 8292 §2 (Push
 *     services reject longer-lived tokens). Default 12 h.
 *
 * Returns the compact JWT (`header.payload.signature`).
 */
/** RFC 8292 §2 ceiling: a VAPID token's `exp` must not exceed 24h. */
const VAPID_EXP_HARD_CAP_SECONDS = 24 * 60 * 60
const VAPID_EXP_DEFAULT_SECONDS = 12 * 60 * 60

export const signVapidJwt = async (params: {
  readonly audience: string
  readonly subject: string
  /** Raw 32-byte P-256 scalar, URL-safe base64. */
  readonly privateKeyBase64Url: string
  /**
   * Raw 65-byte uncompressed P-256 point (`0x04 || x || y`),
   * URL-safe base64. Required so the JWK we hand to WebCrypto
   * carries both `(d, x, y)` — Node's runtime rejects a JWK with
   * only `d`, where the Workers + browser runtimes accept it.
   */
  readonly publicKeyBase64Url: string
  /**
   * Seconds-from-now for the `exp` claim. Defaults to 12h. The
   * effective value is clamped to {@link VAPID_EXP_HARD_CAP_SECONDS}
   * (24h) per RFC 8292 §2 — push services reject longer-lived
   * tokens (Mozilla strictly, others probabilistically).
   */
  readonly expirySeconds?: number
  readonly nowSeconds?: number
}): Promise<string> => {
  const now = params.nowSeconds ?? Math.floor(Date.now() / 1000)
  const requested = params.expirySeconds ?? VAPID_EXP_DEFAULT_SECONDS
  const exp = now + Math.min(requested, VAPID_EXP_HARD_CAP_SECONDS)
  const header = { typ: "JWT", alg: "ES256" }
  const payload = {
    aud: params.audience,
    exp,
    sub: params.subject,
  }
  const headerSegment = bytesToBase64Url(stringToBytes(JSON.stringify(header)))
  const payloadSegment = bytesToBase64Url(stringToBytes(JSON.stringify(payload)))
  const signingInput = `${headerSegment}.${payloadSegment}`

  const privateKey = await importPrivateKey(params.privateKeyBase64Url, params.publicKeyBase64Url)
  const sigDer = await crypto.subtle.sign(
    { name: "ECDSA", hash: { name: "SHA-256" } },
    privateKey,
    stringToBytes(signingInput) as BufferSource,
  )
  // SubtleCrypto returns the IEEE-P1363 raw `r||s` signature for
  // ECDSA (64 bytes), which is also the JWT compact form — no DER
  // unwrapping needed.
  const sigSegment = bytesToBase64Url(new Uint8Array(sigDer))
  return `${signingInput}.${sigSegment}`
}

/**
 * Build the `Authorization` header value RFC 8292 §3.1 prescribes:
 * `vapid t=<JWT>, k=<publicKey>` where `publicKey` is the raw
 * uncompressed P-256 point (65 bytes) URL-safe base64-encoded.
 */
export const vapidAuthorizationHeader = (jwt: string, publicKeyBase64Url: string): string =>
  `vapid t=${jwt}, k=${publicKeyBase64Url}`

/**
 * Import the 32-byte private scalar + 65-byte public point as a
 * JWK private key suitable for `ECDSA / P-256` signing. Node's
 * SubtleCrypto requires the full `(d, x, y)` triple; Workers and
 * browsers accept it too, so this is the portable form.
 */
const importPrivateKey = async (
  privateKeyBase64Url: string,
  publicKeyBase64Url: string,
): Promise<CryptoKey> => {
  const pubRaw = base64UrlToBytes(publicKeyBase64Url)
  if (pubRaw.length !== 65 || pubRaw[0] !== 0x04) {
    throw new Error(
      `signVapidJwt: publicKey must be a 65-byte uncompressed P-256 point (got ${String(pubRaw.length)} bytes)`,
    )
  }
  const x = bytesToBase64Url(pubRaw.slice(1, 33))
  const y = bytesToBase64Url(pubRaw.slice(33, 65))
  const jwk: JsonWebKey = {
    kty: "EC",
    crv: "P-256",
    d: privateKeyBase64Url,
    x,
    y,
    ext: false,
  }
  return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, [
    "sign",
  ])
}

/**
 * Generate a fresh VAPID key pair for deployment-time configuration.
 * Returns both the raw 65-byte uncompressed public point and the
 * raw 32-byte private scalar, each as URL-safe base64. The caller
 * stores the public key as a Pages env var and the private key as
 * a Worker secret (per ADR-0073 §VAPID 鍵管理).
 */
export const generateVapidKeyPair = async (): Promise<{
  readonly publicKeyBase64Url: string
  readonly privateKeyBase64Url: string
}> => {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])
  const jwkPriv = await crypto.subtle.exportKey("jwk", kp.privateKey)
  const jwkPub = await crypto.subtle.exportKey("jwk", kp.publicKey)
  // Public key is the raw uncompressed point: 0x04 || x(32) || y(32).
  if (jwkPub.x === undefined || jwkPub.y === undefined) {
    throw new Error("generateVapidKeyPair: WebCrypto returned a JWK without (x, y)")
  }
  const x = base64UrlToBytes(jwkPub.x)
  const y = base64UrlToBytes(jwkPub.y)
  const raw = new Uint8Array(1 + x.length + y.length)
  raw[0] = 0x04
  raw.set(x, 1)
  raw.set(y, 1 + x.length)
  if (jwkPriv.d === undefined) {
    throw new Error("generateVapidKeyPair: WebCrypto returned a JWK without d")
  }
  return {
    publicKeyBase64Url: bytesToBase64Url(raw),
    privateKeyBase64Url: jwkPriv.d,
  }
}
