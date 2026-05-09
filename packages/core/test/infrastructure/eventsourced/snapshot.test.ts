import { Effect, Layer, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { TicketRepository } from "../../../src/application/ports/EventSourcedRepository.js"
import { CallNext, IssueTicket, MarkServed } from "../../../src/application/usecases/queue/index.js"
import type { CustomerHandle } from "../../../src/domain/value-objects/CustomerHandle.js"
import { NameKanaSchema } from "../../../src/domain/value-objects/NameKana.js"
import { PhoneLast4Schema } from "../../../src/domain/value-objects/PhoneLast4.js"
import { SystemClockLive } from "../../../src/infrastructure/clock/SystemClockLive.js"
import {
  DEFAULT_SNAPSHOT_INTERVAL,
  makeInMemoryTicketRepositoryLive,
} from "../../../src/infrastructure/eventsourced/InMemoryEventSourcedRepositoryLive.js"
import { DeterministicIdGeneratorLive } from "../../../src/infrastructure/id/DeterministicIdGeneratorLive.js"
import { SilentLoggerLive } from "../../../src/infrastructure/logger/SilentLoggerLive.js"

const handle = (kana: string, p4: string): CustomerHandle => ({
  nameKana: Schema.decodeUnknownSync(NameKanaSchema)(kana),
  phoneLast4: Schema.decodeUnknownSync(PhoneLast4Schema)(p4),
})

const layerWithInterval = (interval: number) =>
  Layer.mergeAll(
    SystemClockLive,
    DeterministicIdGeneratorLive,
    makeInMemoryTicketRepositoryLive(interval),
    SilentLoggerLive,
  )

describe("InMemory aggregate snapshot path", () => {
  it("DEFAULT_SNAPSHOT_INTERVAL matches the DO adapter's K=200", () => {
    expect(DEFAULT_SNAPSHOT_INTERVAL).toBe(200)
  })

  it("with K=1 every save fires a snapshot — load returns the correct state across the boundary", async () => {
    const layer = layerWithInterval(1)
    const program = Effect.gen(function* () {
      const t1 = yield* IssueTicket({
        handle: handle("ヤマダ タロウ", "1234"),
        freeText: null,
      })
      const c = yield* CallNext()
      const s = yield* MarkServed(t1.id)
      const repo = yield* TicketRepository
      const loaded = yield* repo.load(t1.id)
      return { t1, c, s, loaded }
    })
    const { t1, c, s, loaded } = await Effect.runPromise(
      program.pipe(Effect.provide(layer), Effect.orDie),
    )
    expect(t1.state).toBe("Waiting")
    expect(c.state).toBe("Called")
    expect(s.state).toBe("Served")
    expect(loaded.state.state).toBe("Served")
    expect(loaded.revision).toBe(3)
  })

  it("with K=2 snapshot fires at revision 2, load replays the delta to revision 3", async () => {
    const layer = layerWithInterval(2)
    const program = Effect.gen(function* () {
      const t = yield* IssueTicket({
        handle: handle("ヤマダ タロウ", "1234"),
        freeText: null,
      })
      yield* CallNext()
      yield* MarkServed(t.id)
      const repo = yield* TicketRepository
      return yield* repo.load(t.id)
    })
    const loaded = await Effect.runPromise(program.pipe(Effect.provide(layer), Effect.orDie))
    expect(loaded.state.state).toBe("Served")
    expect(loaded.revision).toBe(3)
  })

  it("with K=DEFAULT (200) a 3-event lifecycle never reaches the snapshot boundary; load falls through to the projection store", async () => {
    const layer = layerWithInterval(DEFAULT_SNAPSHOT_INTERVAL)
    const program = Effect.gen(function* () {
      const t = yield* IssueTicket({
        handle: handle("ヤマダ タロウ", "1234"),
        freeText: null,
      })
      yield* CallNext()
      yield* MarkServed(t.id)
      const repo = yield* TicketRepository
      return yield* repo.load(t.id)
    })
    const loaded = await Effect.runPromise(program.pipe(Effect.provide(layer), Effect.orDie))
    expect(loaded.state.state).toBe("Served")
    expect(loaded.revision).toBe(3)
  })

  it("snapshot + delta path produces the same structural state as the projection-store path", async () => {
    const program = Effect.gen(function* () {
      const t = yield* IssueTicket({
        handle: handle("タナカ ハナコ", "5678"),
        freeText: null,
      })
      yield* CallNext()
      yield* MarkServed(t.id)
      const repo = yield* TicketRepository
      return yield* repo.load(t.id)
    })
    const viaSnapshot = await Effect.runPromise(
      program.pipe(Effect.provide(layerWithInterval(1)), Effect.orDie),
    )
    const viaProjection = await Effect.runPromise(
      program.pipe(Effect.provide(layerWithInterval(999_999)), Effect.orDie),
    )
    // Structural fields agree; the wall-clock fields drift between
    // runs because each program acquires SystemClock fresh.
    expect(viaSnapshot.state.state).toBe(viaProjection.state.state)
    expect(viaSnapshot.state.id).toBe(viaProjection.state.id)
    expect(viaSnapshot.state.seq).toBe(viaProjection.state.seq)
    expect(viaSnapshot.state.nameKana).toBe(viaProjection.state.nameKana)
    expect(viaSnapshot.state.phoneLast4).toBe(viaProjection.state.phoneLast4)
    expect(viaSnapshot.revision).toBe(viaProjection.revision)
  })
})
