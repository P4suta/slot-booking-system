import { Result } from "effect"
import { expectTypeOf } from "expect-type"
import * as fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
  ALL_ENTITY_KINDS,
  type BookingId,
  type Id,
  newBookingId,
  newId,
  newProviderId,
  newServiceId,
  type ProviderId,
  parseBookingId,
  parseId,
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

  it("Id<E> higher-kinded alias matches per-kind named brand", () => {
    expectTypeOf<Id<"book">>().toEqualTypeOf<BookingId>()
    expectTypeOf<Id<"prov">>().toEqualTypeOf<ProviderId>()
    expectTypeOf<Id<"rsrc">>().toEqualTypeOf<ResourceId>()
  })

  it("round-trips parse(new) for every EntityKind (property)", () => {
    fc.assert(
      fc.property(fc.constantFrom(...ALL_ENTITY_KINDS), (kind) => {
        const id = newId(kind)()
        return Result.isSuccess(parseId(kind)(id))
      }),
      { numRuns: 200 },
    )
  })

  it("rejects every cross-kind pairing (property)", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ALL_ENTITY_KINDS),
        fc.constantFrom(...ALL_ENTITY_KINDS),
        (mintKind, parseKind) => {
          if (mintKind === parseKind) return true
          const id = newId(mintKind)()
          return Result.isFailure(parseId(parseKind)(id))
        },
      ),
      { numRuns: 200 },
    )
  })
})
