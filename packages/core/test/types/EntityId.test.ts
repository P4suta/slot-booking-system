import { Result } from "effect"
import { expectTypeOf } from "expect-type"
import { describe, expect, it } from "vitest"
import {
  type BookingId,
  newBookingId,
  newProviderId,
  newServiceId,
  type ProviderId,
  parseBookingId,
  parseServiceId,
  type ResourceId,
} from "../../src/domain/types/EntityId.js"

describe("EntityId TypeIDs", () => {
  it("generated id has the expected prefix", () => {
    const id = newBookingId()
    expect(id).toMatch(/^book_[0-9a-z]{26}$/)
  })

  it("round-trips parser ∘ generator", () => {
    const id = newServiceId()
    const parsed = parseServiceId(id)
    expect(Result.isSuccess(parsed)).toBe(true)
  })

  it("rejects an id with the wrong prefix", () => {
    const wrong = newProviderId()
    expect(Result.isFailure(parseBookingId(wrong))).toBe(true)
  })

  it("rejects malformed ids", () => {
    for (const bad of ["", "no_prefix_too_long_for_ulid", "BOOK_abc", "book_abc"]) {
      expect(Result.isFailure(parseBookingId(bad))).toBe(true)
    }
  })

  it("brand types are mutually disjoint at the type level", () => {
    expectTypeOf<BookingId>().not.toExtend<ProviderId>()
    expectTypeOf<ProviderId>().not.toExtend<ResourceId>()
    expectTypeOf<BookingId>().toExtend<string>()
  })
})
