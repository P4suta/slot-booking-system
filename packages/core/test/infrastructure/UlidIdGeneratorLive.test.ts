import { Effect, Result } from "effect"
import { describe, expect, it } from "vitest"
import { IdGenerator } from "../../src/application/ports/IdGenerator.js"
import { parseBookingCode } from "../../src/domain/value-objects/BookingCode.js"
import { UlidIdGeneratorLive } from "../../src/infrastructure/id/UlidIdGeneratorLive.js"

describe("UlidIdGeneratorLive", () => {
  const provide = <A, E>(eff: Effect.Effect<A, E, IdGenerator>) =>
    Effect.runPromise(eff.pipe(Effect.provide(UlidIdGeneratorLive)))

  it("emits TypeID-shaped entity ids for every method", async () => {
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
    const ids = await provide(program)
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

  it("emits a checksum-valid 7-char BookingCode that round-trips through parseBookingCode", async () => {
    const program = Effect.gen(function* () {
      const gen = yield* IdGenerator
      return yield* gen.newBookingCode
    })
    const code = await provide(program)
    expect(code).toHaveLength(7)
    const parsed = parseBookingCode(code)
    expect(Result.isSuccess(parsed)).toBe(true)
  })

  it("emits 100 distinct booking codes (uniform sampling, no collisions in a small batch)", async () => {
    const program = Effect.gen(function* () {
      const gen = yield* IdGenerator
      const out: string[] = []
      for (let i = 0; i < 100; i++) out.push(yield* gen.newBookingCode)
      return out
    })
    const codes = await provide(program)
    expect(new Set(codes).size).toBe(100)
  })
})
