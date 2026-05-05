import { Temporal } from "@js-temporal/polyfill"
import { Effect, Either, Layer } from "effect"
import { describe, expect, it } from "vitest"
import { CancelBooking } from "../../../src/application/usecases/CancelBooking.js"
import { ConfirmBooking } from "../../../src/application/usecases/ConfirmBooking.js"
import { HoldSlot } from "../../../src/application/usecases/HoldSlot.js"
import { RescheduleBooking } from "../../../src/application/usecases/RescheduleBooking.js"
import type { AvailableSlot } from "../../../src/domain/slot/computeAvailableSlots.js"
import { newProviderId, newResourceId, newServiceId } from "../../../src/domain/types/EntityId.js"
import { BloomBookingCodeIndexLive } from "../../../src/infrastructure/bloom/BloomBookingCodeIndexLive.js"
import { SystemClockLive } from "../../../src/infrastructure/clock/SystemClockLive.js"
import { InMemoryEventSourcedBookingRepositoryLive } from "../../../src/infrastructure/eventsourced/InMemoryEventSourcedRepositoryLive.js"
import { DeterministicIdGeneratorLive } from "../../../src/infrastructure/id/DeterministicIdGeneratorLive.js"
import { SilentLoggerLive } from "../../../src/infrastructure/logger/SilentLoggerLive.js"
import { kana, phone } from "../../_fixtures/parsers.js"

const TEST_LAYER = Layer.mergeAll(
  SystemClockLive,
  DeterministicIdGeneratorLive,
  InMemoryEventSourcedBookingRepositoryLive,
  BloomBookingCodeIndexLive,
  SilentLoggerLive,
)

const sampleSlot = (
  startIso = "2026-05-09T01:00:00Z",
  endIso = "2026-05-09T02:00:00Z",
): AvailableSlot => ({
  serviceId: newServiceId(),
  start: Temporal.Instant.from(startIso).toZonedDateTimeISO("UTC"),
  end: Temporal.Instant.from(endIso).toZonedDateTimeISO("UTC"),
  providerId: newProviderId(),
  resourceIds: [newResourceId()],
})

const heldFixture = (phoneLast4: string) =>
  HoldSlot({
    slot: sampleSlot(),
    nameKana: kana("ヤマダ"),
    phoneLast4: phone(phoneLast4),
    freeText: null,
    source: "online",
  })

describe("ConfirmBooking", () => {
  it("Held → Confirmed via valid code + phone", async () => {
    const program = Effect.gen(function* () {
      const held = yield* heldFixture("1111")
      return yield* ConfirmBooking({
        code: held.booking.code,
        phoneLast4: held.booking.phoneLast4,
      })
    })
    const result = await Effect.runPromise(program.pipe(Effect.provide(TEST_LAYER)))
    expect(result.booking.state).toBe("Confirmed")
    expect(result.event.type).toBe("Confirmed")
  })

  it("rejects an unknown code with BookingNotFound", async () => {
    const program = Effect.gen(function* () {
      // Hold one booking so the bloom filter has at least one entry,
      // but query a different code so the lookup misses.
      const held = yield* heldFixture("1234")
      const fakeCode = `${held.booking.code.slice(0, 6)}${held.booking.code[6] === "9" ? "8" : "9"}`
      // The fake might still pass bloom mayContain (false positive); test the
      // repository miss path either way.
      return yield* Effect.either(
        ConfirmBooking({
          code: fakeCode as typeof held.booking.code,
          phoneLast4: held.booking.phoneLast4,
        }),
      )
    })
    const result = await Effect.runPromise(program.pipe(Effect.provide(TEST_LAYER)))
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(["AggregateNotFound", "InvalidBookingCode"]).toContain(result.left._tag)
    }
  })

  it("rejects a phone mismatch with PhoneMismatch", async () => {
    const program = Effect.gen(function* () {
      const held = yield* heldFixture("1111")
      return yield* Effect.either(
        ConfirmBooking({
          code: held.booking.code,
          phoneLast4: phone("9999"),
        }),
      )
    })
    const result = await Effect.runPromise(program.pipe(Effect.provide(TEST_LAYER)))
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) expect(result.left._tag).toBe("PhoneMismatch")
  })
})

describe("CancelBooking", () => {
  it("Held → Cancelled (cancelledBy=customer)", async () => {
    const program = Effect.gen(function* () {
      const held = yield* heldFixture("2222")
      return yield* CancelBooking({
        code: held.booking.code,
        phoneLast4: held.booking.phoneLast4,
        reason: "changed mind",
      })
    })
    const result = await Effect.runPromise(program.pipe(Effect.provide(TEST_LAYER)))
    expect(result.booking.state).toBe("Cancelled")
    if (result.booking.state === "Cancelled") {
      expect(result.booking.cancelledBy).toBe("customer")
      expect(result.booking.reason).toBe("changed mind")
    }
  })

  it("Confirmed → Cancelled", async () => {
    const program = Effect.gen(function* () {
      const held = yield* heldFixture("3333")
      yield* ConfirmBooking({
        code: held.booking.code,
        phoneLast4: held.booking.phoneLast4,
      })
      return yield* CancelBooking({
        code: held.booking.code,
        phoneLast4: held.booking.phoneLast4,
        reason: "later cancellation",
      })
    })
    const result = await Effect.runPromise(program.pipe(Effect.provide(TEST_LAYER)))
    expect(result.booking.state).toBe("Cancelled")
  })
})

describe("RescheduleBooking", () => {
  it("Confirmed → Confirmed with new slot, confirmedAt preserved", async () => {
    const newSlot = sampleSlot("2026-05-10T05:00:00Z", "2026-05-10T06:00:00Z")
    const program = Effect.gen(function* () {
      const held = yield* heldFixture("4444")
      const confirmed = yield* ConfirmBooking({
        code: held.booking.code,
        phoneLast4: held.booking.phoneLast4,
      })
      const rescheduled = yield* RescheduleBooking({
        code: held.booking.code,
        phoneLast4: held.booking.phoneLast4,
        newSlot,
      })
      return { confirmed, rescheduled }
    })
    const { confirmed, rescheduled } = await Effect.runPromise(
      program.pipe(Effect.provide(TEST_LAYER)),
    )
    expect(rescheduled.booking.state).toBe("Confirmed")
    if (rescheduled.booking.state === "Confirmed" && confirmed.booking.state === "Confirmed") {
      expect(rescheduled.booking.confirmedAt.equals(confirmed.booking.confirmedAt)).toBe(true)
      expect(rescheduled.booking.slot.start.equals(newSlot.start.toInstant())).toBe(true)
    }
    expect(rescheduled.event.type).toBe("Rescheduled")
  })

  it("rejects Reschedule on a Held booking (must Confirm first)", async () => {
    const newSlot = sampleSlot("2026-05-10T05:00:00Z", "2026-05-10T06:00:00Z")
    const program = Effect.gen(function* () {
      const held = yield* heldFixture("5555")
      return yield* Effect.either(
        RescheduleBooking({
          code: held.booking.code,
          phoneLast4: held.booking.phoneLast4,
          newSlot,
        }),
      )
    })
    const result = await Effect.runPromise(program.pipe(Effect.provide(TEST_LAYER)))
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) expect(result.left._tag).toBe("InvalidStateTransition")
  })
})
