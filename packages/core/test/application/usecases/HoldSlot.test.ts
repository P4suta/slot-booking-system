import { Temporal } from "@js-temporal/polyfill"
import { Effect, Either, Layer } from "effect"
import { describe, expect, it } from "vitest"
import { BookingEventSourcedRepository } from "../../../src/application/ports/EventSourcedRepository.js"
import { HoldSlot } from "../../../src/application/usecases/HoldSlot.js"
import { parseTraceId } from "../../../src/domain/errors/TraceId.js"
import {
  type AvailableSlot,
  mintAvailableSlot,
} from "../../../src/domain/slot/computeAvailableSlots.js"
import { newProviderId, newResourceId, newServiceId } from "../../../src/domain/types/EntityId.js"
import { SystemClockLive } from "../../../src/infrastructure/clock/SystemClockLive.js"
import { InMemoryEventSourcedBookingRepositoryLive } from "../../../src/infrastructure/eventsourced/InMemoryEventSourcedRepositoryLive.js"
import { DeterministicIdGeneratorLive } from "../../../src/infrastructure/id/DeterministicIdGeneratorLive.js"
import {
  makeSilentLogger,
  SilentLoggerLive,
} from "../../../src/infrastructure/logger/SilentLoggerLive.js"
import { freeText, kana, phone } from "../../_fixtures/parsers.js"

const TEST_LAYER = Layer.mergeAll(
  SystemClockLive,
  DeterministicIdGeneratorLive,
  InMemoryEventSourcedBookingRepositoryLive,
  SilentLoggerLive,
)

const sampleSlot = (): AvailableSlot => {
  const tz = "UTC"
  const start = Temporal.Instant.from("2026-05-09T01:00:00Z").toZonedDateTimeISO(tz)
  const end = Temporal.Instant.from("2026-05-09T02:00:00Z").toZonedDateTimeISO(tz)
  return mintAvailableSlot({
    serviceId: newServiceId(),
    start,
    end,
    providerId: newProviderId(),
    resourceIds: [newResourceId()],
  })
}

describe("HoldSlot", () => {
  it("returns a Held booking with the expected fields", async () => {
    const program = HoldSlot({
      slot: sampleSlot(),
      nameKana: kana("ヤマダ タロウ"),
      phoneLast4: phone("1234"),
      freeText: freeText("first time"),
      source: "online",
    })
    const result = await Effect.runPromise(program.pipe(Effect.provide(TEST_LAYER)))
    expect(result.booking.state).toBe("Held")
    expect(result.booking.nameKana).toBe("ヤマダ タロウ")
    expect(result.booking.phoneLast4).toBe("1234")
    expect(result.booking.code).toMatch(/^[0-9A-Z*~$=U]{7}$/)
    expect(result.event.type).toBe("Held")
    expect(result.event.bookingId).toBe(result.booking.id)
  })

  it("expiresAt is heldAt + 5 minutes", async () => {
    const program = HoldSlot({
      slot: sampleSlot(),
      nameKana: kana("ヤマダ タロウ"),
      phoneLast4: phone("1234"),
      freeText: null,
      source: "online",
    })
    const result = await Effect.runPromise(program.pipe(Effect.provide(TEST_LAYER)))
    const diffMs =
      result.booking.expiresAt.epochMilliseconds - result.booking.heldAt.epochMilliseconds
    expect(diffMs).toBe(5 * 60 * 1000)
  })

  it("persists the booking so a subsequent findByCode resolves it", async () => {
    const program = Effect.gen(function* () {
      const held = yield* HoldSlot({
        slot: sampleSlot(),
        nameKana: kana("ヤマダ"),
        phoneLast4: phone("0001"),
        freeText: null,
        source: "online",
      })
      const repo = yield* BookingEventSourcedRepository
      const id = yield* repo.findByKey(held.booking.code)
      const loaded = yield* repo.load(id)
      return { held, found: loaded.state }
    })
    const { held, found } = await Effect.runPromise(program.pipe(Effect.provide(TEST_LAYER)))
    expect(found.id).toBe(held.booking.id)
    expect(found.state).toBe("Held")
  })

  it("makes the new code resolvable via repo.findByKey (the persistence layer maintains the secondary index in lockstep with save)", async () => {
    const program = Effect.gen(function* () {
      const held = yield* HoldSlot({
        slot: sampleSlot(),
        nameKana: kana("ヤマダ"),
        phoneLast4: phone("0002"),
        freeText: null,
        source: "online",
      })
      const repo = yield* BookingEventSourcedRepository
      const id = yield* repo.findByKey(held.booking.code)
      return { held, foundId: id }
    })
    const out = await Effect.runPromise(program.pipe(Effect.provide(TEST_LAYER)))
    expect(out.foundId).toBe(out.held.booking.id)
  })

  it("emits a Held event whose bookingCode matches the booking", async () => {
    const program = HoldSlot({
      slot: sampleSlot(),
      nameKana: kana("サトウ"),
      phoneLast4: phone("9999"),
      freeText: null,
      source: "walkin",
    })
    const r = await Effect.runPromise(program.pipe(Effect.provide(TEST_LAYER)))
    expect(r.event.bookingCode).toBe(r.booking.code)
    expect(r.event.providerId).toBe(r.booking.providerId)
  })

  it("does not leak Either internals into the use case result", async () => {
    const program = HoldSlot({
      slot: sampleSlot(),
      nameKana: kana("ヤマダ"),
      phoneLast4: phone("0000"),
      freeText: null,
      source: "online",
    })
    const result = await Effect.runPromise(program.pipe(Effect.provide(TEST_LAYER)))
    expect(Either.isEither(result as unknown)).toBe(false)
  })

  it("threads a TraceId from the input through the structured log payload", async () => {
    const traceId = Either.getOrThrow(parseTraceId("01H8XRQMKQDNFGXT7NH3AVH3XS"))
    const program = Effect.gen(function* () {
      const handle = yield* makeSilentLogger()
      const traceLayer = Layer.mergeAll(
        handle.layer,
        SystemClockLive,
        DeterministicIdGeneratorLive,
        InMemoryEventSourcedBookingRepositoryLive,
      )
      yield* HoldSlot({
        slot: sampleSlot(),
        nameKana: kana("ヤマダ"),
        phoneLast4: phone("4242"),
        freeText: null,
        source: "online",
        traceId,
      }).pipe(Effect.provide(traceLayer))
      return yield* handle.emitted
    })
    const emitted = await Effect.runPromise(program)
    expect(emitted.length).toBeGreaterThan(0)
    expect(emitted[0]?.payload.traceId).toBe(traceId)
  })
})
