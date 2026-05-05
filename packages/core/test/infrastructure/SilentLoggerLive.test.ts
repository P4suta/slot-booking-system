import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import { Logger } from "../../src/application/ports/Logger.js"
import { SilentLoggerLive } from "../../src/infrastructure/logger/SilentLoggerLive.js"

/**
 * SilentLoggerLive drops every payload. The use cases exercise `info`
 * extensively, but `warn` and `error` are reserved for Phase 1's
 * observability surface — they need at-least-once coverage today so
 * the `100 %` C1 gate stays meaningful as new sinks are added.
 */

const payload = (code: string) =>
  ({
    _tag: "LogTag",
    code,
    severity: "domain" as const,
    data: {},
  }) as const

describe("SilentLoggerLive", () => {
  it("info / warn / error each return Effect.void", async () => {
    const program = Effect.gen(function* () {
      const log = yield* Logger
      yield* log.info(payload("I_TEST"))
      yield* log.warn(payload("W_TEST"))
      yield* log.error(payload("E_TEST"))
      return "done"
    })
    const result = await Effect.runPromise(program.pipe(Effect.provide(SilentLoggerLive)))
    expect(result).toBe("done")
  })

  it("composes with Layer.merge", () => {
    const merged = Layer.merge(SilentLoggerLive, SilentLoggerLive)
    expect(merged).toBeDefined()
  })
})
