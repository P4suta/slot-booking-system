import { Either, Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  type Capability,
  CapabilitySchema,
  type CustomerCapability,
  CustomerCapabilitySchema,
  hasScope,
  type StaffCapability,
  StaffCapabilitySchema,
  StaffScopeSchema,
  type SystemCapability,
  SystemCapabilitySchema,
  SystemReasonSchema,
  subjectOf,
} from "../../../src/domain/auth/Capability.js"
import { newStaffId } from "../../../src/domain/types/EntityId.js"
import {
  encodeBookingCode,
  formatBookingCode,
} from "../../../src/domain/value-objects/BookingCode.js"

const decodeCustomer = Schema.decodeUnknownEither(CustomerCapabilitySchema)
const decodeStaff = Schema.decodeUnknownEither(StaffCapabilitySchema)
const decodeSystem = Schema.decodeUnknownEither(SystemCapabilitySchema)
const decodeAny = Schema.decodeUnknownEither(CapabilitySchema)

/** Valid booking-code samples generated through the bigint codec (no hand-rolled checksum). */
const validCode = formatBookingCode(Either.getOrThrow(encodeBookingCode(123n)))
const otherCode = formatBookingCode(Either.getOrThrow(encodeBookingCode(456n)))

describe("CapabilitySchema (discriminated union)", () => {
  it("decodes a valid CustomerCapability with a Crockford-32 booking code + last4", () => {
    const decoded = decodeAny({
      _tag: "CustomerCapability",
      bookingCode: validCode,
      phoneLast4: "1234",
    })
    expect(Either.isRight(decoded)).toBe(true)
    if (Either.isRight(decoded)) {
      expect(decoded.right._tag).toBe("CustomerCapability")
      // Confirm the discriminant narrows the type — these accesses
      // only compile inside the `CustomerCapability` branch.
      const customer: CustomerCapability = decoded.right as CustomerCapability
      expect(customer.phoneLast4).toBe("1234")
    }
  })

  it("decodes a valid StaffCapability with a TypeID staff id and a non-empty scope set", () => {
    const staffId = newStaffId()
    const decoded = decodeStaff({
      _tag: "StaffCapability",
      staffId,
      scopes: ["cancel", "complete"],
    })
    expect(Either.isRight(decoded)).toBe(true)
  })

  it("rejects a StaffCapability with an empty scope list (NonEmptyArray)", () => {
    const decoded = decodeStaff({
      _tag: "StaffCapability",
      staffId: newStaffId(),
      scopes: [],
    })
    expect(Either.isLeft(decoded)).toBe(true)
  })

  it("rejects a StaffCapability with an unknown scope literal", () => {
    const decoded = decodeStaff({
      _tag: "StaffCapability",
      staffId: newStaffId(),
      scopes: ["delete"],
    })
    expect(Either.isLeft(decoded)).toBe(true)
  })

  it("decodes a valid SystemCapability with a closed-set reason", () => {
    const decoded = decodeSystem({ _tag: "SystemCapability", reason: "expire" })
    expect(Either.isRight(decoded)).toBe(true)
    const decoded2 = decodeSystem({ _tag: "SystemCapability", reason: "purge" })
    expect(Either.isRight(decoded2)).toBe(true)
  })

  it("rejects a SystemCapability with an unknown reason", () => {
    const decoded = decodeSystem({ _tag: "SystemCapability", reason: "bogus" })
    expect(Either.isLeft(decoded)).toBe(true)
  })

  it("rejects a CustomerCapability with a malformed phone last4", () => {
    const decoded = decodeCustomer({
      _tag: "CustomerCapability",
      bookingCode: validCode,
      phoneLast4: "12",
    })
    expect(Either.isLeft(decoded)).toBe(true)
  })

  it("rejects a CustomerCapability with a booking code failing checksum", () => {
    const decoded = decodeCustomer({
      _tag: "CustomerCapability",
      bookingCode: "ZZZZ-ZZZ",
      phoneLast4: "1234",
    })
    expect(Either.isLeft(decoded)).toBe(true)
  })

  it("rejects values lacking the _tag discriminator", () => {
    const decoded = decodeAny({ bookingCode: validCode, phoneLast4: "1234" })
    expect(Either.isLeft(decoded)).toBe(true)
  })
})

describe("subjectOf", () => {
  it("returns 'customer' / 'staff' / 'system' per discriminator", () => {
    const cust: Capability = Either.getOrThrow(
      decodeCustomer({
        _tag: "CustomerCapability",
        bookingCode: validCode,
        phoneLast4: "1234",
      }),
    )
    expect(subjectOf(cust)).toBe("customer")

    const staff: StaffCapability = Either.getOrThrow(
      decodeStaff({
        _tag: "StaffCapability",
        staffId: newStaffId(),
        scopes: ["cancel"],
      }),
    )
    expect(subjectOf(staff)).toBe("staff")

    const system: SystemCapability = Either.getOrThrow(
      decodeSystem({ _tag: "SystemCapability", reason: "expire" }),
    )
    expect(subjectOf(system)).toBe("system")
  })

  it("distinguishes two customer capabilities by their booking-code credential", () => {
    const a = Either.getOrThrow(
      decodeCustomer({
        _tag: "CustomerCapability",
        bookingCode: validCode,
        phoneLast4: "1111",
      }),
    )
    const b = Either.getOrThrow(
      decodeCustomer({
        _tag: "CustomerCapability",
        bookingCode: otherCode,
        phoneLast4: "2222",
      }),
    )
    expect(a.bookingCode).not.toBe(b.bookingCode)
  })
})

describe("hasScope", () => {
  it("returns true iff the scope appears in the staff capability's scope list", () => {
    const cap = Either.getOrThrow(
      decodeStaff({
        _tag: "StaffCapability",
        staffId: newStaffId(),
        scopes: ["cancel", "complete"],
      }),
    )
    expect(hasScope(cap, "cancel")).toBe(true)
    expect(hasScope(cap, "complete")).toBe(true)
    expect(hasScope(cap, "reschedule")).toBe(false)
    expect(hasScope(cap, "noshow")).toBe(false)
  })
})

describe("StaffScopeSchema / SystemReasonSchema closed sets", () => {
  it("StaffScopeSchema.literals enumerates all permissible scopes", () => {
    expect(StaffScopeSchema.literals).toEqual(["cancel", "reschedule", "complete", "noshow"])
  })

  it("SystemReasonSchema.literals enumerates all permissible reasons", () => {
    expect(SystemReasonSchema.literals).toEqual(["expire", "purge"])
  })
})
