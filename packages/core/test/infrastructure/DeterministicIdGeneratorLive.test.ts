import { Effect, Result } from "effect"
import { describe, expect, it } from "vitest"
import { IdGenerator } from "../../src/application/ports/IdGenerator.js"
import { parseBookingCode } from "../../src/domain/value-objects/BookingCode.js"
import {
  DeterministicIdGeneratorLive,
  makeDeterministicIdGenerator,
} from "../../src/infrastructure/id/DeterministicIdGeneratorLive.js"

describe("DeterministicIdGeneratorLive", () => {
  it("emits the same id sequence across two runs of the same seed", async () => {
    const program = Effect.gen(function* () {
      const gen = yield* IdGenerator
      const a = yield* gen.newBookingId
      const b = yield* gen.newServiceId
      const c = yield* gen.newBookingEventId
      return [a, b, c] as const
    })
    const run = () =>
      Effect.runPromise(program.pipe(Effect.provide(makeDeterministicIdGenerator(0n))))
    const first = await run()
    const second = await run()
    expect(second).toEqual(first)
  })

  it("yields TypeID-shaped strings for every entity prefix", async () => {
    const program = Effect.gen(function* () {
      const gen = yield* IdGenerator
      return {
        booking: yield* gen.newBookingId,
        service: yield* gen.newServiceId,
        provider: yield* gen.newProviderId,
        resource: yield* gen.newResourceId,
        closure: yield* gen.newClosureId,
        absence: yield* gen.newProviderAbsenceId,
        hours: yield* gen.newBusinessHoursId,
        event: yield* gen.newBookingEventId,
        audit: yield* gen.newAuditLogId,
        idem: yield* gen.newIdempotencyKeyId,
      }
    })
    const ids = await Effect.runPromise(program.pipe(Effect.provide(DeterministicIdGeneratorLive)))
    expect(ids.booking).toMatch(/^book_[0-9a-z]{26}$/)
    expect(ids.service).toMatch(/^serv_[0-9a-z]{26}$/)
    expect(ids.provider).toMatch(/^prov_[0-9a-z]{26}$/)
    expect(ids.resource).toMatch(/^rsrc_[0-9a-z]{26}$/)
    expect(ids.closure).toMatch(/^clos_[0-9a-z]{26}$/)
    expect(ids.absence).toMatch(/^absn_[0-9a-z]{26}$/)
    expect(ids.hours).toMatch(/^bhrs_[0-9a-z]{26}$/)
    expect(ids.event).toMatch(/^evnt_[0-9a-z]{26}$/)
    expect(ids.audit).toMatch(/^audt_[0-9a-z]{26}$/)
    expect(ids.idem).toMatch(/^idem_[0-9a-z]{26}$/)
  })

  it("yields a checksum-valid 7-char BookingCode that round-trips through parseBookingCode", async () => {
    const program = Effect.gen(function* () {
      const gen = yield* IdGenerator
      return yield* gen.newBookingCode
    })
    const code = await Effect.runPromise(program.pipe(Effect.provide(DeterministicIdGeneratorLive)))
    expect(code).toHaveLength(7)
    expect(Result.isSuccess(parseBookingCode(code))).toBe(true)
  })

  it("different seeds produce different starting ids", async () => {
    const program = Effect.gen(function* () {
      const gen = yield* IdGenerator
      return yield* gen.newBookingId
    })
    const fromZero = await Effect.runPromise(
      program.pipe(Effect.provide(makeDeterministicIdGenerator(0n))),
    )
    const fromHundred = await Effect.runPromise(
      program.pipe(Effect.provide(makeDeterministicIdGenerator(100n))),
    )
    expect(fromZero).not.toBe(fromHundred)
  })
})
