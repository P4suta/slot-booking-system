import { describe, expect, it } from "vitest"
import { base64UrlToBytes, bytesToString } from "../src/base64url.js"
import { generateVapidKeyPair, signVapidJwt, vapidAuthorizationHeader } from "../src/vapid.js"

describe("signVapidJwt", () => {
  it("produces a verifiable ES256 JWT", async () => {
    const { publicKeyBase64Url, privateKeyBase64Url } = await generateVapidKeyPair()
    const jwt = await signVapidJwt({
      audience: "https://fcm.googleapis.com",
      subject: "https://example.com/push-contact",
      privateKeyBase64Url,
      publicKeyBase64Url,
      expirySeconds: 60,
      nowSeconds: 1_000_000,
    })

    // Compact JWT shape.
    const parts = jwt.split(".")
    expect(parts).toHaveLength(3)
    const [headerSegment, payloadSegment, sigSegment] = parts as [string, string, string]

    // Header.
    const header = JSON.parse(bytesToString(base64UrlToBytes(headerSegment))) as {
      readonly typ: string
      readonly alg: string
    }
    expect(header).toEqual({ typ: "JWT", alg: "ES256" })

    // Payload — exp claim was honoured.
    const payload = JSON.parse(bytesToString(base64UrlToBytes(payloadSegment))) as {
      readonly aud: string
      readonly exp: number
      readonly sub: string
    }
    expect(payload.aud).toBe("https://fcm.googleapis.com")
    expect(payload.exp).toBe(1_000_060)
    expect(payload.sub).toBe("https://example.com/push-contact")

    // Signature — verify with the matching public key. The public
    // key was returned by generateVapidKeyPair as the raw 65-byte
    // uncompressed point; convert back to a JWK for verify.
    const pubRaw = base64UrlToBytes(publicKeyBase64Url)
    expect(pubRaw[0]).toBe(0x04)
    expect(pubRaw.length).toBe(65)
    const x = pubRaw.slice(1, 33)
    const y = pubRaw.slice(33, 65)
    const { bytesToBase64Url } = await import("../src/base64url.js")
    const verifyKey = await crypto.subtle.importKey(
      "jwk",
      {
        kty: "EC",
        crv: "P-256",
        x: bytesToBase64Url(x),
        y: bytesToBase64Url(y),
        ext: true,
      },
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    )
    const signingInput = new TextEncoder().encode(`${headerSegment}.${payloadSegment}`)
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      verifyKey,
      base64UrlToBytes(sigSegment) as BufferSource,
      signingInput,
    )
    expect(ok).toBe(true)
  })

  it("rejects signatures verified with the wrong public key", async () => {
    const a = await generateVapidKeyPair()
    const b = await generateVapidKeyPair()
    const jwt = await signVapidJwt({
      audience: "https://fcm.googleapis.com",
      subject: "https://example.com/push-contact",
      privateKeyBase64Url: a.privateKeyBase64Url,
      publicKeyBase64Url: a.publicKeyBase64Url,
      nowSeconds: 1_000_000,
    })
    const [headerSegment, payloadSegment, sigSegment] = jwt.split(".") as [string, string, string]
    const pubRaw = base64UrlToBytes(b.publicKeyBase64Url)
    const x = pubRaw.slice(1, 33)
    const y = pubRaw.slice(33, 65)
    const { bytesToBase64Url } = await import("../src/base64url.js")
    const verifyKey = await crypto.subtle.importKey(
      "jwk",
      {
        kty: "EC",
        crv: "P-256",
        x: bytesToBase64Url(x),
        y: bytesToBase64Url(y),
        ext: true,
      },
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    )
    const signingInput = new TextEncoder().encode(`${headerSegment}.${payloadSegment}`)
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      verifyKey,
      base64UrlToBytes(sigSegment) as BufferSource,
      signingInput,
    )
    expect(ok).toBe(false)
  })

  it("vapidAuthorizationHeader formats per RFC 8292", () => {
    const header = vapidAuthorizationHeader("JWT.STRING", "PUB-BASE64URL")
    expect(header).toBe("vapid t=JWT.STRING, k=PUB-BASE64URL")
  })

  // T2: RFC 8292 §2 hard cap. expirySeconds is clamped to 24h so a
  // misconfigured caller (or one that forgot the spec) never produces
  // a JWT push services would reject.
  it("clamps expirySeconds to 24h per RFC 8292 §2", async () => {
    const { publicKeyBase64Url, privateKeyBase64Url } = await generateVapidKeyPair()
    const nowSeconds = 1_700_000_000
    const jwt = await signVapidJwt({
      audience: "https://fcm.googleapis.com",
      subject: "https://example.com/push-contact",
      privateKeyBase64Url,
      publicKeyBase64Url,
      expirySeconds: 25 * 60 * 60, // 25h — over the spec cap
      nowSeconds,
    })
    const [, payloadSegment] = jwt.split(".") as [string, string, string]
    const payload = JSON.parse(bytesToString(base64UrlToBytes(payloadSegment))) as {
      readonly exp: number
    }
    expect(payload.exp - nowSeconds).toBe(24 * 60 * 60)
  })

  it("respects expirySeconds when under the 24h cap", async () => {
    const { publicKeyBase64Url, privateKeyBase64Url } = await generateVapidKeyPair()
    const nowSeconds = 1_700_000_000
    const jwt = await signVapidJwt({
      audience: "https://fcm.googleapis.com",
      subject: "https://example.com/push-contact",
      privateKeyBase64Url,
      publicKeyBase64Url,
      expirySeconds: 30 * 60, // 30min
      nowSeconds,
    })
    const [, payloadSegment] = jwt.split(".") as [string, string, string]
    const payload = JSON.parse(bytesToString(base64UrlToBytes(payloadSegment))) as {
      readonly exp: number
    }
    expect(payload.exp - nowSeconds).toBe(30 * 60)
  })
})
