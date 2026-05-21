import { base64UrlToBytes, bytesToBase64Url, stringToBytes } from "./base64url.js"

/**
 * RFC 8291 aes128gcm message encryption for Web Push.
 *
 * The client (browser) presents a static P-256 public key
 * (`p256dh`) and a 16-byte `auth` secret as part of the
 * subscription. To send an encrypted payload the server:
 *
 *   1. Generates an ephemeral P-256 ECDH key pair.
 *   2. ECDH-derives `shared_secret = ECDH(ephemeralPriv, clientPub)`.
 *   3. PRK_key = HMAC-SHA-256(auth, shared_secret)            (HKDF-Extract)
 *   4. key_info = "WebPush: info\0" || clientPub || ephemeralPub
 *      IKM   = HMAC-SHA-256(PRK_key, key_info || 0x01)        (HKDF-Expand, L=32)
 *   5. PRK = HMAC-SHA-256(salt, IKM)                          (HKDF-Extract)
 *   6. CEK = HMAC-SHA-256(PRK, "Content-Encoding: aes128gcm\0" || 0x01)[0..16]
 *   7. NONCE = HMAC-SHA-256(PRK, "Content-Encoding: nonce\0" || 0x01)[0..12]
 *   8. ciphertext = AES-128-GCM(CEK, NONCE, plaintext || 0x02)
 *   9. Frame the wire bytes: `salt(16) || rs(4) || idlen(1) || keyid(65) || ciphertext`
 *
 * `rs` is the record size (RFC 8188). We send a single record of
 * the full payload, so `rs ≥ ciphertext.length + 17`. We use the
 * customary 4096 so any conforming reader accepts the frame.
 *
 * Tests can pass `salt` / `ephemeralKeyPair` overrides for
 * determinism; the production path generates both.
 */

export type ClientPublicKey = {
  /** Browser-supplied raw uncompressed P-256 point, URL-safe base64. */
  readonly p256dh: string
  /** Browser-supplied 16-byte auth secret, URL-safe base64. */
  readonly auth: string
}

export type EncryptPayloadInput = {
  readonly plaintext: Uint8Array
  readonly client: ClientPublicKey
  /** Optional injection for property tests; ignored in production. */
  readonly salt?: Uint8Array
  /** Optional injection for property tests; ignored in production. */
  readonly ephemeralKeyPair?: CryptoKeyPair
}

export type EncryptedPushPayload = {
  readonly body: Uint8Array
  readonly ephemeralPublicKeyBase64Url: string
  readonly salt: Uint8Array
}

const concat = (...parts: readonly Uint8Array[]): Uint8Array => {
  let total = 0
  for (const p of parts) total += p.length
  const out = new Uint8Array(total)
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}

const hmacSha256 = async (key: Uint8Array, data: Uint8Array): Promise<Uint8Array> => {
  // TS 6's tightened `Uint8Array<ArrayBufferLike>` is not assignable
  // to `BufferSource` (which expects `ArrayBufferView<ArrayBuffer>`).
  // The `as BufferSource` casts are safe here because every value
  // passed to a SubtleCrypto call in this file is materialised
  // through `new Uint8Array(n)` or `.slice()`, both of which produce
  // a private `ArrayBuffer` (not a `SharedArrayBuffer`).
  const k = await crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const sig = await crypto.subtle.sign("HMAC", k, data as BufferSource)
  return new Uint8Array(sig)
}

const hkdfExpandOneBlock = async (
  prk: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> => {
  const block = await hmacSha256(prk, concat(info, Uint8Array.of(0x01)))
  return block.slice(0, length)
}

const randomBytes = (length: number): Uint8Array => {
  const out = new Uint8Array(length)
  crypto.getRandomValues(out)
  return out
}

const generateEphemeralKeyPair = (): Promise<CryptoKeyPair> =>
  crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])

const importClientPublicKey = (rawP256dh: Uint8Array): Promise<CryptoKey> =>
  crypto.subtle.importKey(
    "raw",
    rawP256dh as BufferSource,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  )

const exportRawPublicKey = async (publicKey: CryptoKey): Promise<Uint8Array> => {
  const raw = await crypto.subtle.exportKey("raw", publicKey)
  return new Uint8Array(raw)
}

const deriveSharedSecret = async (
  privateKey: CryptoKey,
  publicKey: CryptoKey,
): Promise<Uint8Array> => {
  const bits = await crypto.subtle.deriveBits({ name: "ECDH", public: publicKey }, privateKey, 256)
  return new Uint8Array(bits)
}

const aesGcmEncrypt = async (
  keyBytes: Uint8Array,
  iv: Uint8Array,
  plaintext: Uint8Array,
): Promise<Uint8Array> => {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes as BufferSource,
    { name: "AES-GCM", length: 128 },
    false,
    ["encrypt"],
  )
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource, tagLength: 128 },
    key,
    plaintext as BufferSource,
  )
  return new Uint8Array(ct)
}

const KEY_INFO_PREFIX = stringToBytes("WebPush: info\0")
const CEK_INFO = stringToBytes("Content-Encoding: aes128gcm\0")
const NONCE_INFO = stringToBytes("Content-Encoding: nonce\0")
const PADDING_DELIMITER = Uint8Array.of(0x02)
const RECORD_SIZE = 4096

/**
 * Encrypt `plaintext` for the given client subscription. The
 * returned `body` is the RFC 8291 framed record the caller POSTs
 * to the push service.
 */
export const encryptPayload = async (input: EncryptPayloadInput): Promise<EncryptedPushPayload> => {
  const clientPubRaw = base64UrlToBytes(input.client.p256dh)
  const clientAuth = base64UrlToBytes(input.client.auth)

  const ephemeral = input.ephemeralKeyPair ?? (await generateEphemeralKeyPair())
  const ephemeralPubRaw = await exportRawPublicKey(ephemeral.publicKey)
  const clientPubKey = await importClientPublicKey(clientPubRaw)
  const sharedSecret = await deriveSharedSecret(ephemeral.privateKey, clientPubKey)

  // Step 3 — PRK_key = HKDF-Extract(salt=auth, IKM=ECDH)
  const prkKey = await hmacSha256(clientAuth, sharedSecret)

  // Step 4 — IKM = HKDF-Expand(PRK_key, key_info, 32)
  const keyInfo = concat(KEY_INFO_PREFIX, clientPubRaw, ephemeralPubRaw)
  const ikm = await hkdfExpandOneBlock(prkKey, keyInfo, 32)

  // Step 5 — PRK = HKDF-Extract(salt, IKM)
  const salt = input.salt ?? randomBytes(16)
  const prk = await hmacSha256(salt, ikm)

  // Step 6/7 — derive CEK + NONCE.
  const cek = await hkdfExpandOneBlock(prk, CEK_INFO, 16)
  const nonce = await hkdfExpandOneBlock(prk, NONCE_INFO, 12)

  // Step 8 — AES-128-GCM(plaintext || 0x02). Single-record payload
  // uses 0x02 as the trailing record delimiter (RFC 8188 §2).
  const padded = concat(input.plaintext, PADDING_DELIMITER)
  const ciphertext = await aesGcmEncrypt(cek, nonce, padded)

  // Step 9 — frame: salt(16) || rs(4) || idlen(1) || keyid(65) || ciphertext
  const rs = new Uint8Array(4)
  new DataView(rs.buffer).setUint32(0, RECORD_SIZE, false /* big-endian */)
  const idlen = Uint8Array.of(ephemeralPubRaw.length)
  const body = concat(salt, rs, idlen, ephemeralPubRaw, ciphertext)

  return {
    body,
    ephemeralPublicKeyBase64Url: bytesToBase64Url(ephemeralPubRaw),
    salt,
  }
}
