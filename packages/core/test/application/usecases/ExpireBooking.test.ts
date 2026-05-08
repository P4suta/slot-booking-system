import { Temporal } from "@js-temporal/polyfill"
import { Effect, Layer, Result } from "effect"
import { describe, expect, it } from "vitest"
import { ExpireBooking } from "../../../src/application/usecases/ExpireBooking.js"
import { HoldSlot } from "../../../src/application/usecases/HoldSlot.js"
import {
  type AvailableSlot,
  mintAvailableSlot,
} from "../../../src/domain/slot/computeAvailableSlots.js"
import { newProviderId, newResourceId, newServiceId } from "../../../src/domain/types/EntityId.js"
import { SystemClockLive } from "../../../src/infrastructure/clock/SystemClockLive.js"
import { InMemoryEventSourcedBookingRepositoryLive } from "../../../src/infrastructure/eventsourced/InMemoryEventSourcedRepositoryLive.js"
import { DeterministicIdGeneratorLive } from "../../../src/infrastructure/id/DeterministicIdGeneratorLive.js"
import { SilentLoggerLive } from "../../../src/infrastructure/logger/SilentLoggerLive.js"
import { kana, phone } from "../../_fixtures/parsers.js"

const TEST_LAYER = Layer.mergeAll(
  SystemClockLive,
  DeterministicIdGeneratorLive,
  InMemoryEventSourcedBookingRepositoryLive,
  SilentLoggerLive,
)

const sampleSlot = (): AvailableSlot =>
  mintAvailableSlot({
    serviceId: newServiceId(),
    start: Temporal.Instant.from("2026-05-09T01:00:00Z").toZonedDateTimeISO("UTC"),
    end: Temporal.Instant.from("2026-05-09T02:00:00Z").toZonedDateTimeISO("UTC"),
    providerId: newProviderId(),
    resourceIds: [newResourceId()],
  })

describe("ExpireBooking", () => {
  it("Held → Cancelled with cancelledBy=system", async () => {
    const program = Effect.gen(function* () {
      const held = yield* HoldSlot({
        slot: sampleSlot(),
        nameKana: kana("ヤマダ"),
        phoneLast4: phone("1234"),
        freeText: null,
        source: "online",
      })
      return yield* ExpireBooking({ bookingId: held.booking.id })
    })
    const result = await Effect.runPromise(program.pipe(Effect.provide(TEST_LAYER)))
    expect(result.booking.state).toBe("Cancelled")
    if (result.booking.state === "Cancelled") {
      expect(result.booking.cancelledBy).toBe("system")
      expect(result.booking.reason).toBe("hold expired")
    }
    expect(result.event.type).toBe("Cancelled")
  })

  it("AggregateNotFound when the booking id is unknown", async () => {
    const program = ExpireBooking({
      bookingId: "book_missing00000000000000" as ReturnType<typeof newServiceId> as never,
    })
    const result = await Effect.runPromise(program.pipe(Effect.provide(TEST_LAYER), Effect.result))
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure._tag).toBe("AggregateNotFound")
    }
  })
})
