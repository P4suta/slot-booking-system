import { Either } from "effect"
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
    expect(Either.isRight(parsed)).toBe(true)
  })

  it("rejects an id with the wrong prefix", () => {
    const wrong = newProviderId()
    expect(Either.isLeft(parseBookingId(wrong))).toBe(true)
  })

  it("rejects malformed ids", () => {
    for (const bad of ["", "no_prefix_too_long_for_ulid", "BOOK_abc", "book_abc"]) {
      expect(Either.isLeft(parseBookingId(bad))).toBe(true)
    }
  })

  it("brand types are mutually disjoint at the type level", () => {
    expectTypeOf<BookingId>().not.toMatchTypeOf<ProviderId>()
    expectTypeOf<ProviderId>().not.toMatchTypeOf<ResourceId>()
    expectTypeOf<BookingId>().toMatchTypeOf<string>()
  })
})
