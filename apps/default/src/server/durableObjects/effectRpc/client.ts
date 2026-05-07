import { Deferred, Effect, type Scope } from "effect"
import { RpcClient, type RpcGroup } from "effect/unstable/rpc"
import { RpcClientDefect, RpcClientError } from "effect/unstable/rpc/RpcClientError"
import type { DaySchedule } from "../DaySchedule.js"
import { DayScheduleRouter } from "./router.js"
import {
  desanitiseFromStructuredClone,
  messagingAttributesFor,
  sanitiseForStructuredClone,
} from "./transport.js"

type DayScheduleRpcs = typeof DayScheduleRouter extends RpcGroup.RpcGroup<infer R> ? R : never
type DayScheduleClient = RpcClient.RpcClient<DayScheduleRpcs, RpcClientError>

type WriteFn = (msg: never) => Effect.Effect<void>

/**
 * Phase 2.8 / BI-4 — typed `effect/unstable/rpc` client over Cloudflare DO RPC.
 *
 * The DO surface (`stub.dispatch(envelope)`) is the only transport
 * channel; both the inbound `FromClientEncoded` request envelope and
 * the outbound `FromServerEncoded` response envelope are pure JSON,
 * so they survive Cloudflare's `structuredClone` boundary unchanged.
 *
 * `RpcClient.makeNoSerialization` wires the client's `onFromClient`
 * callback to forward each envelope to the DO and feed the reply back
 * into the client through `write(reply)`. `supportsAck: false` matches
 * the request/response shape of DO method invocations (no half-open
 * streams).
 *
 * The `Deferred` resolves the chicken-and-egg between `onFromClient`
 * (which needs `write`) and `makeNoSerialization` (whose factory
 * returns `write` only **after** the callback is registered). The
 * callback `Effect.gen` blocks on `Deferred.await(writeReady)` until
 * the constructor below resolves it — single hop per request, no
 * race because the deferred is fulfilled synchronously after
 * `makeNoSerialization` returns.
 *
 * Phase 3 PR#8 / commit 12 — every dispatch hop is wrapped in an
 * OpenTelemetry messaging-semconv span (`messaging.system =
 * "cloudflare.do"`, `rpc.method = <envelope.tag>`,
 * `messaging.destination.name = <day-key>`). The span is opened
 * inside `onFromClient` so the trace tree is `graphql.<Verb>` →
 * `messaging.cloudflare.do.dispatch` → DO-side `usecase.<Verb>` —
 * three layers, each with its own attribute namespace.
 *
 * Usage from a resolver:
 *   ```ts
 *   const stub = dayDoFor(env, date)
 *   const program = Effect.gen(function* () {
 *     const client = yield* makeDayScheduleClient(stub, `DaySchedule:${date}`)
 *     return yield* client.HoldSlot(payload)
 *   })
 *   const result = await runRpcOrThrow(Effect.scoped(program))
 *   ```
 *
 * The factory returns an `Effect<Client, never, Scope>` — the caller
 * must run the program inside `Effect.scoped(...)` so the client's
 * resources (the underlying RpcClient internals) are released after
 * the request.
 */
export const makeDayScheduleClient = (
  stub: DurableObjectStub<DaySchedule>,
  destination: string,
): Effect.Effect<DayScheduleClient, never, Scope.Scope> =>
  Effect.gen(function* () {
    const writeReady = yield* Deferred.make<WriteFn>()
    const { client, write } = yield* RpcClient.makeNoSerialization(DayScheduleRouter, {
      supportsAck: false,
      onFromClient: ({ message, discard }) =>
        Effect.gen(function* () {
          if (discard) return
          const sanitisedReply: unknown = yield* Effect.tryPromise({
            try: () => Promise.resolve<unknown>(stub.dispatch(sanitiseForStructuredClone(message))),
            catch: (cause) =>
              new RpcClientError({
                reason: new RpcClientDefect({
                  message: cause instanceof Error ? cause.message : "DO RPC dispatch failed",
                  cause,
                }),
              }),
          }).pipe(
            Effect.withSpan("messaging.cloudflare.do.dispatch", {
              attributes: messagingAttributesFor(message, destination),
            }),
          )
          const reply = desanitiseFromStructuredClone(sanitisedReply)
          if (typeof reply === "object" && reply !== null) {
            const w = yield* Deferred.await(writeReady)
            yield* w(reply as Parameters<WriteFn>[0])
          }
        }),
    })
    yield* Deferred.succeed(writeReady, write as WriteFn)
    return client
  })
