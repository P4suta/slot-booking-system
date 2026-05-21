import { Context, Effect, Layer } from "effect"
import type { PushSubscription, SendPushResult } from "./client.js"
import { sendPush } from "./client.js"

/**
 * Application-layer port (ADR-0020) for the Web Push channel.
 * Inverts the WebCrypto-and-fetch dependency so the queue alarm
 * dispatch path can be tested without a network adapter and so
 * the production wiring (`WebCryptoPushChannelLive`) and the
 * in-memory test wiring (`inMemoryPushChannelHandle().layer`)
 * share the same call site.
 */
export class PushChannel extends Context.Service<
  PushChannel,
  {
    readonly send: (
      subscription: PushSubscription,
      payload: Uint8Array,
    ) => Effect.Effect<SendPushResult>
  }
>()("@booking/push/PushChannel") {}

export type WebCryptoPushChannelConfig = {
  readonly vapidPublicKeyBase64Url: string
  readonly vapidPrivateKeyBase64Url: string
  readonly subject: string
  readonly ttl?: number
  readonly fetchImpl?: typeof fetch
}

/**
 * Production layer — calls the real push services. The config is
 * a parameter, not a Tag, because the deployment binds the VAPID
 * key pair at boot from Worker secrets / env (ADR-0073).
 */
export const WebCryptoPushChannelLive = (
  config: WebCryptoPushChannelConfig,
): Layer.Layer<PushChannel> =>
  // `sendPush` is total — every failure path returns a tagged
  // SendPushResult variant rather than throwing. `Effect.promise`
  // preserves that totality; a genuine defect surfaces through
  // Effect's die channel instead of being misclassified as
  // `transportError`.
  Layer.succeed(PushChannel, {
    send: (subscription, payload) =>
      Effect.promise(() =>
        sendPush({
          subscription,
          payload,
          vapidPublicKeyBase64Url: config.vapidPublicKeyBase64Url,
          vapidPrivateKeyBase64Url: config.vapidPrivateKeyBase64Url,
          subject: config.subject,
          ...(config.ttl !== undefined ? { ttl: config.ttl } : {}),
          ...(config.fetchImpl !== undefined ? { fetchImpl: config.fetchImpl } : {}),
        }),
      ),
  })

/**
 * Test layer — records every send call without any network or
 * WebCrypto activity. Returns a fixed `delivered` envelope unless
 * the caller installs a different reply via `replyWith`.
 */
export type InMemoryPushChannelHandle = {
  readonly calls: readonly {
    readonly subscription: PushSubscription
    readonly payload: Uint8Array
  }[]
  readonly replyWith: (reply: SendPushResult) => void
  readonly layer: Layer.Layer<PushChannel>
}

export const inMemoryPushChannelHandle = (): InMemoryPushChannelHandle => {
  const calls: {
    readonly subscription: PushSubscription
    readonly payload: Uint8Array
  }[] = []
  let nextReply: SendPushResult = { kind: "delivered", status: 201 }
  const layer = Layer.succeed(PushChannel, {
    send: (subscription, payload) => {
      calls.push({ subscription, payload })
      return Effect.succeed(nextReply)
    },
  })
  return {
    calls,
    replyWith: (reply) => {
      nextReply = reply
    },
    layer,
  }
}
