import { BookingNotFoundError, Logger, type LogPayload } from "@booking/core"
import { Effect, Layer } from "effect"
import { RpcClientDefect, RpcClientError } from "effect/unstable/rpc/RpcClientError"
import { describe, expect, it } from "vitest"
import { tapErrorAsRpcOrDomain } from "../../src/server/graphql/effectRpcRunner.js"

/**
 * `tapErrorAsRpcOrDomain` — the structured-logging arm of the resolver
 * boundary. The Effect surface is the unit of test (the async bridge
 * `runRpcOrThrow` itself wraps `Effect.runPromise` and is exercised by
 * the smoke / Miniflare suites). Two arms:
 *
 *   1. `RpcClientError` — synthetic transport-tier failure; the
 *      operator must see the underlying `reason._tag` + `message`
 *      (e.g. `DataCloneError`) so the cause is not lost behind the
 *      `TransportError` GraphQL synthetic.
 *   2. `DomainError` — funnels through `toLogPayload` so the structured
 *      shape matches every other domain log entry.
 *
 * Both arms must propagate the original error unchanged after the log
 * call (tap semantics).
 */

const makeCollector = () => {
  const sink: LogPayload[] = []
  const layer = Layer.succeed(
    Logger,
    Logger.of({
      info: () => Effect.void,
      warn: () => Effect.void,
      error: (payload) =>
        Effect.sync(() => {
          sink.push(payload)
        }),
    }),
  )
  return { sink, layer }
}

describe("tapErrorAsRpcOrDomain", () => {
  it("logs the underlying reason on RpcClientError without losing the cause preview", async () => {
    const { sink, layer } = makeCollector()
    const cause = new TypeError('Could not serialize object of type "Object"')
    cause.name = "DataCloneError"
    const transportFailure = new RpcClientError({
      reason: new RpcClientDefect({ message: cause.message, cause }),
    })

    const program = tapErrorAsRpcOrDomain(Effect.fail(transportFailure)).pipe(Effect.provide(layer))
    const exit = await Effect.runPromiseExit(program)

    expect(exit._tag).toBe("Failure")
    expect(sink).toHaveLength(1)
    expect(sink[0]).toMatchObject({
      _tag: "RpcClientError",
      code: "E_INF_TRANSPORT",
      severity: "infrastructure",
      data: {
        reason: "RpcClientDefect",
        message: 'Could not serialize object of type "Object"',
      },
      cause: {
        name: "DataCloneError",
        message: 'Could not serialize object of type "Object"',
      },
    })
  })

  it("logs the canonical toLogPayload on DomainError without altering the failure", async () => {
    const { sink, layer } = makeCollector()
    const program = tapErrorAsRpcOrDomain(Effect.fail(new BookingNotFoundError())).pipe(
      Effect.provide(layer),
    )
    const exit = await Effect.runPromiseExit(program)

    expect(exit._tag).toBe("Failure")
    expect(sink).toHaveLength(1)
    expect(sink[0]).toMatchObject({
      _tag: "BookingNotFound",
      code: "E_DOM_BOOKING_NOT_FOUND",
      severity: "domain",
      data: {},
    })
    expect(sink[0]).not.toHaveProperty("cause")
  })

  it("emits no log call on success", async () => {
    const { sink, layer } = makeCollector()
    const program = tapErrorAsRpcOrDomain(Effect.succeed(42)).pipe(Effect.provide(layer))
    const value = await Effect.runPromise(program)

    expect(value).toBe(42)
    expect(sink).toHaveLength(0)
  })
})
