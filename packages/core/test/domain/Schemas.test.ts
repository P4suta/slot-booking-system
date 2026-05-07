import { Temporal } from "@js-temporal/polyfill"
import { Result, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { BookingSchema } from "../../src/domain/booking/Booking.js"
import { ClosureSchema } from "../../src/domain/entities/Closure.js"
import { ResourceSchema } from "../../src/domain/entities/Resource.js"
import { ServiceSchema } from "../../src/domain/entities/Service.js"
import { BookingEventSchema } from "../../src/domain/events/BookingEvent.js"
import { newBookingEventId, newBookingId } from "../../src/domain/types/EntityId.js"
import { InstantSchema, PlainDateSchema, PlainTimeSchema } from "../../src/domain/types/Temporal.js"
import { baseHeld } from "../_fixtures/bookings.js"
import { bookingCode, holdingDays, resourceType, skill } from "../_fixtures/parsers.js"

describe("InstantSchema", () => {
  it("round-trips an ISO string ↔ Temporal.Instant", () => {
    const iso = "2026-05-05T09:00:00Z"
    const decoded = Schema.decodeUnknownResult(InstantSchema)(iso)
    expect(Result.isSuccess(decoded)).toBe(true)
    if (Result.isSuccess(decoded)) {
      const back = Schema.encodeSync(InstantSchema)(decoded.success)
      expect(back).toBe(iso)
    }
  })

  it("rejects a malformed ISO string", () => {
    expect(Result.isFailure(Schema.decodeUnknownResult(InstantSchema)("not-a-date"))).toBe(true)
  })
})

describe("PlainDateSchema", () => {
  it("round-trips ISO date", () => {
    const iso = "2026-05-05"
    const decoded = Schema.decodeUnknownResult(PlainDateSchema)(iso)
    expect(Result.isSuccess(decoded)).toBe(true)
    if (Result.isSuccess(decoded)) {
      expect(Schema.encodeSync(PlainDateSchema)(decoded.success)).toBe(iso)
    }
  })

  it("rejects a malformed date", () => {
    expect(Result.isFailure(Schema.decodeUnknownResult(PlainDateSchema)("nope"))).toBe(true)
  })
})

describe("PlainTimeSchema", () => {
  it("round-trips ISO time", () => {
    const iso = "09:30:00"
    const decoded = Schema.decodeUnknownResult(PlainTimeSchema)(iso)
    expect(Result.isSuccess(decoded)).toBe(true)
    if (Result.isSuccess(decoded)) {
      expect(Schema.encodeSync(PlainTimeSchema)(decoded.success)).toMatch(/^09:30/)
    }
  })

  it("rejects a malformed time", () => {
    expect(Result.isFailure(Schema.decodeUnknownResult(PlainTimeSchema)("25:99"))).toBe(true)
  })
})

describe("Entity Schemas", () => {
  it("ServiceSchema accepts a well-formed Service", () => {
    const sample = {
      id: "serv_01h8xrqmkqdnfgxt7nh3avh3xs",
      name: "test",
      description: "desc",
      durationMinutes: 60,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      holdingDays: holdingDays(0),
      requiredSkills: new Set([skill("a")]),
      requiredResourceTypes: new Set([resourceType("ws")]),
      enabled: true,
    }
    expect(Schema.is(ServiceSchema)(sample)).toBe(true)
  })

  it("ClosureSchema accepts a well-formed Closure", () => {
    const sample = {
      id: "clos_01h8xrqmkqdnfgxt7nh3avh3xs",
      date: Temporal.PlainDate.from("2026-05-05"),
      reason: "national holiday",
    }
    expect(Schema.is(ClosureSchema)(sample)).toBe(true)
  })

  it("ResourceSchema accepts a well-formed Resource", () => {
    const sample = {
      id: "rsrc_01h8xrqmkqdnfgxt7nh3avh3xs",
      name: "ws-1",
      type: resourceType("workspace"),
      enabled: true,
    }
    expect(Schema.is(ResourceSchema)(sample)).toBe(true)
  })
})

describe("BookingSchema", () => {
  it("accepts a Held variant produced by the existing fixture", () => {
    const held = baseHeld()
    expect(Schema.is(BookingSchema)(held)).toBe(true)
  })
})

describe("BookingEventSchema", () => {
  it("accepts a Held event built from a Held booking", () => {
    const held = baseHeld()
    const at = Temporal.Instant.from("2026-05-05T09:00:00Z")
    const event = {
      id: newBookingEventId(),
      bookingId: newBookingId(),
      version: 1 as const,
      occurredAt: at,
      recordedAt: at,
      type: "Held" as const,
      bookingCode: bookingCode(0n),
      serviceId: held.serviceId,
      providerId: held.providerId,
      resourceIds: held.resourceIds,
      slot: held.slot,
    }
    expect(Schema.is(BookingEventSchema)(event)).toBe(true)
  })
})
