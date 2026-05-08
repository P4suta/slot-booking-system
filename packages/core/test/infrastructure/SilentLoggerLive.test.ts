import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import { Logger } from "../../src/application/ports/Logger.js"
import {
  makeSilentLogger,
  SilentLoggerLive,
} from "../../src/infrastructure/logger/SilentLoggerLive.js"

/**
 * SilentLoggerLive drops every payload. Pin `warn` / `error` paths
 * with at-least-once coverage so the 100% C1 gate stays meaningful
 * as new sinks are added.
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

  it("makeSilentLogger retains the most recent emissions for assertions", async () => {
    const program = Effect.gen(function* () {
      const handle = yield* makeSilentLogger()
      const child = Effect.gen(function* () {
        const log = yield* Logger
        yield* log.info(payload("I_HELLO"))
        yield* log.warn(payload("W_HELLO"))
        yield* log.error(payload("E_HELLO"))
      })
      yield* child.pipe(Effect.provide(handle.layer))
      return yield* handle.emitted
    })
    const entries = await Effect.runPromise(program)
    expect(entries.map((e) => e.level)).toEqual(["info", "warn", "error"])
    expect(entries.map((e) => e.payload.code)).toEqual(["I_HELLO", "W_HELLO", "E_HELLO"])
  })
})
