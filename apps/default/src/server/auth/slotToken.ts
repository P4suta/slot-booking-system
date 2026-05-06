import type { AvailableSlotShape } from "@booking/core"

/**
 * HMAC-signed token over an `AvailableSlot` payload. Phase 0.7-α5
 * brand-on-`AvailableSlot` documents the constraint: only the
 * server-side computer (`computeAvailableSlots`) may mint a slot
 * value that the write-side use cases will accept. The token is the
 * runtime evidence that travels with the slot through the GraphQL
 * round-trip:
 *
 *   1. `availableSlots` resolver emits `{ shape, token }` pairs;
 *      the token is `base64url(payload).base64url(signature)` where
 *      signature = HMAC-SHA256(SLOT_HMAC_SECRET, payload).
 *   2. The client passes the token unchanged to `holdSlot` /
 *      `rescheduleBooking`.
 *   3. The mutation resolver verifies the token on receipt and
 *      reconstructs the `AvailableSlotShape` from the payload —
 *      tampered fields fail the signature check before reaching the
 *      DO RPC, keeping `mintAvailableSlot` honest.
 *
 * The signing key is `env.SLOT_HMAC_SECRET` (hex). The Worker
 * derives a `CryptoKey` from it once per request and re-uses it for
 * verification; HMAC-SHA-256 with a 32-byte key is the WebCrypto
 * default and stays inside the Workers runtime.
 */

const TOKEN_VERSION = "v1"

const utf8 = new TextEncoder()

const base64UrlEncode = (data: ArrayBuffer | Uint8Array): string => {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  let out = ""
  for (const b of bytes) out += String.fromCharCode(b)
  return btoa(out).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

const base64UrlDecode = (input: string): Uint8Array<ArrayBuffer> => {
  const padded =
    input.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (input.length % 4)) % 4)
  const decoded = atob(padded)
  const bytes = new Uint8Array(new ArrayBuffer(decoded.length))
  for (let i = 0; i < decoded.length; i += 1) bytes[i] = decoded.charCodeAt(i)
  return bytes
}

const importHmacKey = async (secretHex: string): Promise<CryptoKey> => {
  if (!/^[0-9a-fA-F]{64}$/.test(secretHex)) {
    throw new Error(
      "SLOT_HMAC_SECRET must be 32 bytes (64 hex chars) — current value has the wrong shape",
    )
  }
  const raw = new Uint8Array(new ArrayBuffer(32))
  for (let i = 0; i < 32; i += 1) raw[i] = Number.parseInt(secretHex.slice(i * 2, i * 2 + 2), 16)
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ])
}

type SlotPayload = {
  readonly v: typeof TOKEN_VERSION
  readonly serviceId: string
  readonly start: string
  readonly end: string
  readonly providerId: string
  readonly resourceIds: readonly string[]
}

const payloadOf = (shape: AvailableSlotShape): SlotPayload => ({
  v: TOKEN_VERSION,
  serviceId: shape.serviceId,
  start: shape.start.toInstant().toString(),
  end: shape.end.toInstant().toString(),
  providerId: shape.providerId,
  resourceIds: shape.resourceIds,
})

/**
 * Sign an `AvailableSlotShape` and produce the wire token. The token
 * is `<base64url payload>.<base64url signature>`.
 */
export const signSlot = async (secretHex: string, shape: AvailableSlotShape): Promise<string> => {
  const key = await importHmacKey(secretHex)
  const payloadBytes = utf8.encode(JSON.stringify(payloadOf(shape)))
  const sigBytes = await crypto.subtle.sign("HMAC", key, payloadBytes)
  return `${base64UrlEncode(payloadBytes)}.${base64UrlEncode(sigBytes)}`
}

export type DecodedSlot = {
  readonly serviceId: string
  readonly start: string
  readonly end: string
  readonly providerId: string
  readonly resourceIds: readonly string[]
}

/**
 * Verify a token under the secret. On a valid token, returns the
 * decoded slot fields. On any mismatch (shape / version / signature),
 * returns null so the caller raises a typed refusal.
 */
export const verifySlotToken = async (
  secretHex: string,
  token: string,
): Promise<DecodedSlot | null> => {
  const parts = token.split(".")
  if (parts.length !== 2) return null
  const [payloadB64, sigB64] = parts
  if (!payloadB64 || !sigB64) return null
  let payloadBytes: Uint8Array<ArrayBuffer>
  let sigBytes: Uint8Array<ArrayBuffer>
  try {
    payloadBytes = base64UrlDecode(payloadB64)
    sigBytes = base64UrlDecode(sigB64)
  } catch {
    return null
  }
  const key = await importHmacKey(secretHex)
  const ok = await crypto.subtle.verify("HMAC", key, sigBytes, payloadBytes)
  if (!ok) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(payloadBytes))
  } catch {
    return null
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("v" in parsed) ||
    (parsed as { readonly v: unknown }).v !== TOKEN_VERSION
  ) {
    return null
  }
  const candidate = parsed as Partial<DecodedSlot> & { readonly v: string }
  if (
    typeof candidate.serviceId !== "string" ||
    typeof candidate.start !== "string" ||
    typeof candidate.end !== "string" ||
    typeof candidate.providerId !== "string" ||
    !Array.isArray(candidate.resourceIds) ||
    !candidate.resourceIds.every((r) => typeof r === "string")
  ) {
    return null
  }
  return {
    serviceId: candidate.serviceId,
    start: candidate.start,
    end: candidate.end,
    providerId: candidate.providerId,
    resourceIds: candidate.resourceIds,
  }
}
