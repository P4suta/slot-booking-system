import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import { useCaseEnv } from "../../../src/application/usecases/_withUseCaseEnv.js"
import { SystemClockLive } from "../../../src/infrastructure/clock/SystemClockLive.js"
import { InMemoryTicketRepositoryLive } from "../../../src/infrastructure/eventsourced/InMemoryEventSourcedRepositoryLive.js"
import { DeterministicIdGeneratorLive } from "../../../src/infrastructure/id/DeterministicIdGeneratorLive.js"
import { SilentLoggerLive } from "../../../src/infrastructure/logger/SilentLoggerLive.js"

describe("useCaseEnv", () => {
  it("aggregates Clock / IdGenerator / TicketRepository / Logger into one bind", async () => {
    const layer = Layer.mergeAll(
      SystemClockLive,
      DeterministicIdGeneratorLive,
      InMemoryTicketRepositoryLive,
      SilentLoggerLive,
    )
    const env = await Effect.runPromise(
      useCaseEnv.pipe(Effect.provide(layer)) as unknown as Effect.Effect<{
        readonly clock: unknown
        readonly idgen: unknown
        readonly repo: unknown
        readonly logger: unknown
      }>,
    )
    expect(env.clock).toBeDefined()
    expect(env.idgen).toBeDefined()
    expect(env.repo).toBeDefined()
    expect(env.logger).toBeDefined()
  })
})
