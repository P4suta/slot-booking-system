import { describe, expect, it } from "vitest"
import {
  AlreadyCancelled,
  AlreadyCompleted,
  AlreadyNoShow,
  BookingNotFound,
  InvalidBitmap,
  InvalidStateTransition,
  OutsideBusinessHours,
  PhoneMismatch,
  ProviderUnavailable,
  ResourceUnavailable,
  ServiceDisabled,
  SlotExpired,
  SlotUnavailable,
} from "../../src/domain/errors/DomainError.js"

describe("DomainError", () => {
  it("constants carry the expected discriminator tag", () => {
    expect(BookingNotFound._tag).toBe("BookingNotFound")
    expect(PhoneMismatch._tag).toBe("PhoneMismatch")
    expect(AlreadyCancelled._tag).toBe("AlreadyCancelled")
    expect(AlreadyCompleted._tag).toBe("AlreadyCompleted")
    expect(AlreadyNoShow._tag).toBe("AlreadyNoShow")
    expect(SlotExpired._tag).toBe("SlotExpired")
    expect(SlotUnavailable._tag).toBe("SlotUnavailable")
    expect(OutsideBusinessHours._tag).toBe("OutsideBusinessHours")
    expect(ServiceDisabled._tag).toBe("ServiceDisabled")
    expect(ProviderUnavailable._tag).toBe("ProviderUnavailable")
    expect(ResourceUnavailable._tag).toBe("ResourceUnavailable")
  })

  it("constructors carry their reason payload", () => {
    const ib = InvalidBitmap("bad")
    expect(ib._tag).toBe("InvalidBitmap")
    if (ib._tag === "InvalidBitmap") {
      expect(ib.reason).toBe("bad")
    }
    const tr = InvalidStateTransition("Held", "Complete")
    expect(tr._tag).toBe("InvalidStateTransition")
    if (tr._tag === "InvalidStateTransition") {
      expect(tr.from).toBe("Held")
      expect(tr.command).toBe("Complete")
    }
  })
})
