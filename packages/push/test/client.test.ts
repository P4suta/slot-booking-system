import { describe, expect, it } from "vitest"
import { sendPush } from "../src/client.js"
import { generateVapidKeyPair } from "../src/vapid.js"

const fakeSubscription = async () => {
  // Generate the same kind of P-256 ECDH key the browser would
  // hand the server in real life.
  const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey))
  const auth = new Uint8Array(16)
  crypto.getRandomValues(auth)
  const { bytesToBase64Url } = await import("../src/base64url.js")
  return {
    endpoint: "https://fcm.googleapis.com/fcm/send/abcdef",
    p256dh: bytesToBase64Url(raw),
    auth: bytesToBase64Url(auth),
  }
}

describe("sendPush", () => {
  it("delivered: returns kind=delivered on 201", async () => {
    const sub = await fakeSubscription()
    const vapid = await generateVapidKeyPair()
    let captured: { url: string; init: RequestInit } | null = null
    const fetchImpl: typeof fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      captured = { url, init: init ?? {} }
      return Promise.resolve(new Response(null, { status: 201 }))
    }
    const result = await sendPush({
      subscription: sub,
      payload: new TextEncoder().encode("hi"),
      vapidPublicKeyBase64Url: vapid.publicKeyBase64Url,
      vapidPrivateKeyBase64Url: vapid.privateKeyBase64Url,
      subject: "https://example.com/push-contact",
      fetchImpl,
    })
    expect(result).toEqual({ kind: "delivered", status: 201 })
    const c = captured as unknown as { url: string; init: RequestInit }
    expect(c.url).toBe(sub.endpoint)
    expect(c.init.method).toBe("POST")
    const headers = c.init.headers as Record<string, string>
    expect(headers["Content-Encoding"]).toBe("aes128gcm")
    expect(headers.Authorization).toMatch(/^vapid t=[^,]+, k=/)
    expect(headers.TTL).toBe("60")
  })

  it("subscriptionGone: returns kind=subscriptionGone on 410", async () => {
    const sub = await fakeSubscription()
    const vapid = await generateVapidKeyPair()
    const fetchImpl: typeof fetch = () => Promise.resolve(new Response(null, { status: 410 }))
    const result = await sendPush({
      subscription: sub,
      payload: new TextEncoder().encode("hi"),
      vapidPublicKeyBase64Url: vapid.publicKeyBase64Url,
      vapidPrivateKeyBase64Url: vapid.privateKeyBase64Url,
      subject: "https://example.com/push-contact",
      fetchImpl,
    })
    expect(result).toEqual({ kind: "subscriptionGone", status: 410 })
  })

  it("subscriptionGone: returns kind=subscriptionGone on 404", async () => {
    const sub = await fakeSubscription()
    const vapid = await generateVapidKeyPair()
    const fetchImpl: typeof fetch = () => Promise.resolve(new Response(null, { status: 404 }))
    const result = await sendPush({
      subscription: sub,
      payload: new TextEncoder().encode("hi"),
      vapidPublicKeyBase64Url: vapid.publicKeyBase64Url,
      vapidPrivateKeyBase64Url: vapid.privateKeyBase64Url,
      subject: "https://example.com/push-contact",
      fetchImpl,
    })
    expect(result.kind).toBe("subscriptionGone")
  })

  it("rejected: returns kind=rejected with status + body on non-2xx", async () => {
    const sub = await fakeSubscription()
    const vapid = await generateVapidKeyPair()
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(new Response("payload too large", { status: 413 }))
    const result = await sendPush({
      subscription: sub,
      payload: new TextEncoder().encode("hi"),
      vapidPublicKeyBase64Url: vapid.publicKeyBase64Url,
      vapidPrivateKeyBase64Url: vapid.privateKeyBase64Url,
      subject: "https://example.com/push-contact",
      fetchImpl,
    })
    expect(result.kind).toBe("rejected")
    if (result.kind === "rejected") {
      expect(result.status).toBe(413)
      expect(result.body).toContain("payload too large")
    }
  })

  it("transportError: returns kind=transportError on fetch throw", async () => {
    const sub = await fakeSubscription()
    const vapid = await generateVapidKeyPair()
    const fetchImpl: typeof fetch = () => Promise.reject(new Error("network down"))
    const result = await sendPush({
      subscription: sub,
      payload: new TextEncoder().encode("hi"),
      vapidPublicKeyBase64Url: vapid.publicKeyBase64Url,
      vapidPrivateKeyBase64Url: vapid.privateKeyBase64Url,
      subject: "https://example.com/push-contact",
      fetchImpl,
    })
    expect(result.kind).toBe("transportError")
    if (result.kind === "transportError") {
      expect(result.cause).toBeInstanceOf(Error)
    }
  })
})
