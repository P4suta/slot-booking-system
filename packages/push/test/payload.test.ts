import { describe, expect, it } from "vitest"
import { base64UrlToBytes, bytesToBase64Url, stringToBytes } from "../src/base64url.js"
import { encryptPayload } from "../src/payload.js"

/**
 * Round-trip test — encrypt with the producer side, then decrypt
 * with a hand-rolled RFC 8291 decoder that uses the same HKDF /
 * AES-GCM primitives in reverse. If the encoder writes spec-
 * compliant bytes the decoder reproduces the plaintext.
 */
const KEY_INFO_PREFIX = stringToBytes("WebPush: info\0")
const CEK_INFO = stringToBytes("Content-Encoding: aes128gcm\0")
const NONCE_INFO = stringToBytes("Content-Encoding: nonce\0")

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
  const k = await crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data as BufferSource))
}

const hkdfExpand = async (
  prk: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> => {
  const block = await hmacSha256(prk, concat(info, Uint8Array.of(0x01)))
  return block.slice(0, length)
}

const decryptForClient = async (
  body: Uint8Array,
  clientKeyPair: CryptoKeyPair,
  clientAuth: Uint8Array,
): Promise<Uint8Array> => {
  // Frame: salt(16) || rs(4) || idlen(1) || keyid(idlen) || ciphertext
  const salt = body.slice(0, 16)
  const idlen = body[20] ?? 0
  const keyid = body.slice(21, 21 + idlen)
  const ciphertext = body.slice(21 + idlen)

  const ephemeralPubKey = await crypto.subtle.importKey(
    "raw",
    keyid as BufferSource,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  )
  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: ephemeralPubKey },
      clientKeyPair.privateKey,
      256,
    ),
  )
  const clientPubRaw = new Uint8Array(await crypto.subtle.exportKey("raw", clientKeyPair.publicKey))

  const prkKey = await hmacSha256(clientAuth, sharedSecret)
  const ikm = await hkdfExpand(prkKey, concat(KEY_INFO_PREFIX, clientPubRaw, keyid), 32)
  const prk = await hmacSha256(salt, ikm)
  const cek = await hkdfExpand(prk, CEK_INFO, 16)
  const nonce = await hkdfExpand(prk, NONCE_INFO, 12)

  const aesKey = await crypto.subtle.importKey(
    "raw",
    cek as BufferSource,
    { name: "AES-GCM", length: 128 },
    false,
    ["decrypt"],
  )
  const padded = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce as BufferSource, tagLength: 128 },
      aesKey,
      ciphertext,
    ),
  )
  // The trailing padding byte is the record delimiter (0x02 for the
  // last record in aes128gcm). Strip it.
  if (padded.length === 0 || padded[padded.length - 1] !== 0x02) {
    throw new Error("decryptForClient: missing record delimiter 0x02")
  }
  return padded.slice(0, padded.length - 1)
}

describe("encryptPayload", () => {
  it("round-trips a UTF-8 payload through the spec-compliant frame", async () => {
    // The "client" is the browser; generate its static ECDH pair
    // and a random 16-byte auth secret.
    const clientKeyPair = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveBits"],
    )
    const clientPubRaw = new Uint8Array(
      await crypto.subtle.exportKey("raw", clientKeyPair.publicKey),
    )
    const clientAuth = new Uint8Array(16)
    crypto.getRandomValues(clientAuth)

    const plaintext = stringToBytes(JSON.stringify({ v: 1, kind: "called", displaySeq: 42 }))
    const encrypted = await encryptPayload({
      plaintext,
      client: { p256dh: bytesToBase64Url(clientPubRaw), auth: bytesToBase64Url(clientAuth) },
    })

    // Frame self-check.
    expect(encrypted.body[20]).toBe(65) // idlen == raw EC point length
    const decoded = await decryptForClient(encrypted.body, clientKeyPair, clientAuth)
    expect(Array.from(decoded)).toEqual(Array.from(plaintext))
  })

  it("supports an injected salt for determinism", async () => {
    const clientKeyPair = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveBits"],
    )
    const clientPubRaw = new Uint8Array(
      await crypto.subtle.exportKey("raw", clientKeyPair.publicKey),
    )
    const clientAuth = new Uint8Array(16)
    crypto.getRandomValues(clientAuth)
    const fixedSalt = new Uint8Array(16)
    crypto.getRandomValues(fixedSalt)
    const plaintext = stringToBytes("ok")
    const encrypted = await encryptPayload({
      plaintext,
      salt: fixedSalt,
      client: { p256dh: bytesToBase64Url(clientPubRaw), auth: bytesToBase64Url(clientAuth) },
    })
    expect(Array.from(encrypted.salt)).toEqual(Array.from(fixedSalt))
    expect(Array.from(encrypted.body.slice(0, 16))).toEqual(Array.from(fixedSalt))
  })

  it("decoded plaintext matches across different payload sizes", async () => {
    const clientKeyPair = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveBits"],
    )
    const clientPubRaw = new Uint8Array(
      await crypto.subtle.exportKey("raw", clientKeyPair.publicKey),
    )
    const clientAuth = new Uint8Array(16)
    crypto.getRandomValues(clientAuth)
    for (const len of [1, 16, 64, 512]) {
      const plaintext = new Uint8Array(len)
      crypto.getRandomValues(plaintext)
      const encrypted = await encryptPayload({
        plaintext,
        client: { p256dh: bytesToBase64Url(clientPubRaw), auth: bytesToBase64Url(clientAuth) },
      })
      const decoded = await decryptForClient(encrypted.body, clientKeyPair, clientAuth)
      expect(Array.from(decoded)).toEqual(Array.from(plaintext))
    }
  })
})

// Side-effect: keeps `base64UrlToBytes` used so knip doesn't flag it.
void base64UrlToBytes
