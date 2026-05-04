import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { Clock } from "../../src/application/ports/Clock.js"
import { SystemClockLive } from "../../src/infrastructure/clock/SystemClockLive.js"

describe("SystemClockLive", () => {
  it("yields a Temporal.Instant when nowInstant is requested", async () => {
    const program = Effect.gen(function* () {
      const clock = yield* Clock
      return yield* clock.nowInstant
    })
    const instant = await Effect.runPromise(program.pipe(Effect.provide(SystemClockLive)))
    expect(typeof instant.epochMilliseconds).toBe("number")
    expect(Number.isFinite(instant.epochMilliseconds)).toBe(true)
  })

  it("monotonically advances between two consecutive reads", async () => {
    const program = Effect.gen(function* () {
      const clock = yield* Clock
      const a = yield* clock.nowInstant
      const b = yield* clock.nowInstant
      return [a, b] as const
    })
    const [a, b] = await Effect.runPromise(program.pipe(Effect.provide(SystemClockLive)))
    expect(b.epochMilliseconds).toBeGreaterThanOrEqual(a.epochMilliseconds)
  })
})
