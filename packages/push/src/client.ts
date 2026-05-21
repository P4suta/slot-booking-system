import { encryptPayload } from "./payload.js"
import { signVapidJwt, vapidAuthorizationHeader } from "./vapid.js"

/**
 * The browser-supplied subscription a server needs to send a push:
 * the (opaque) push-service endpoint URL + the ECDH public key and
 * auth secret used by the {@link encryptPayload} pipeline.
 */
export type PushSubscription = {
  readonly endpoint: string
  readonly p256dh: string
  readonly auth: string
}

export type SendPushParams = {
  readonly subscription: PushSubscription
  readonly payload: Uint8Array
  readonly vapidPublicKeyBase64Url: string
  readonly vapidPrivateKeyBase64Url: string
  readonly subject: string
  readonly ttl?: number
  /** Override the global `fetch` (tests inject a mock). */
  readonly fetchImpl?: typeof fetch
}

/**
 * The four outcomes the push-service handshake can produce. The
 * caller — typically the `Nudge` use-case dispatcher inside
 * `QueueShop.alarm()` — branches on this so a `subscriptionGone`
 * row can be reaped from `push_subscriptions` immediately.
 */
export type SendPushResult =
  | { readonly kind: "delivered"; readonly status: number }
  | { readonly kind: "subscriptionGone"; readonly status: 404 | 410 }
  | { readonly kind: "rejected"; readonly status: number; readonly body: string }
  | { readonly kind: "transportError"; readonly cause: unknown }

const audienceOf = (endpoint: string): string => {
  const url = new URL(endpoint)
  return `${url.protocol}//${url.host}`
}

/**
 * POST an encrypted push to a single subscription. The function is
 * deterministic on `(subscription, payload, vapid keys, subject)`
 * modulo the ephemeral ECDH key + the JWT `exp` claim, both of
 * which the protocol allows to vary per call.
 */
export const sendPush = async (params: SendPushParams): Promise<SendPushResult> => {
  const fetchImpl = params.fetchImpl ?? fetch
  let body: Uint8Array
  let jwt: string
  try {
    const encrypted = await encryptPayload({
      plaintext: params.payload,
      client: { p256dh: params.subscription.p256dh, auth: params.subscription.auth },
    })
    body = encrypted.body
    jwt = await signVapidJwt({
      audience: audienceOf(params.subscription.endpoint),
      subject: params.subject,
      privateKeyBase64Url: params.vapidPrivateKeyBase64Url,
      publicKeyBase64Url: params.vapidPublicKeyBase64Url,
    })
  } catch (cause) {
    return { kind: "transportError", cause }
  }

  let res: Response
  try {
    res = await fetchImpl(params.subscription.endpoint, {
      method: "POST",
      headers: {
        Authorization: vapidAuthorizationHeader(jwt, params.vapidPublicKeyBase64Url),
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: String(params.ttl ?? 60),
      },
      // TS 6 narrowed `BodyInit`: `Uint8Array<ArrayBufferLike>` does
      // not match `Uint8Array<ArrayBuffer>`. The wire bytes we send
      // are guaranteed ArrayBuffer-backed (the encrypted record is
      // built via `new Uint8Array(total)`); the cast is safe.
      // TODO: revisit when the boundary-cast cleanup lands; the
      // `payload.ts` pattern of an explicit `as BufferSource` with a
      // justifying comment may also satisfy this site.
      body: body as unknown as BodyInit,
    })
  } catch (cause) {
    return { kind: "transportError", cause }
  }

  if (res.status === 404 || res.status === 410) {
    return { kind: "subscriptionGone", status: res.status }
  }
  if (res.status >= 200 && res.status < 300) {
    return { kind: "delivered", status: res.status }
  }
  // Drain the body for diagnostics. Push services typically return
  // plain text under a few hundred bytes; cap so a buggy peer cannot
  // OOM the Worker.
  const text = await res.text().catch(() => "")
  return { kind: "rejected", status: res.status, body: text.slice(0, 1024) }
}
