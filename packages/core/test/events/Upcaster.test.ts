import { Schema } from "effect"
import { describe, expect, expectTypeOf, it } from "vitest"
import { BookingEventSchema } from "../../src/domain/events/BookingEvent.js"
import {
  lookupCodec,
  type Upcaster,
  upcastFrom,
  upcastToLatest,
  upcastWith,
} from "../../src/domain/events/Upcaster.js"
import { newBookingEventId } from "../../src/domain/types/EntityId.js"
import { at, baseHeld } from "../_fixtures/index.js"

const encode = Schema.encodeSync(BookingEventSchema)

describe("Upcaster type", () => {
  it("is the canonical event upgrader signature `(From) => To`", () => {
    type V1 = { kind: "v1"; payload: number }
    type V2 = { kind: "v2"; payload: string }
    const fn: Upcaster<V1, V2> = (e) => ({ kind: "v2", payload: e.payload.toString() })
    expectTypeOf(fn).parameter(0).toEqualTypeOf<V1>()
    expectTypeOf(fn).returns.toEqualTypeOf<V2>()
  })
})

describe("upcastToLatest", () => {
  it("identity on a wire-shape latest-version event", () => {
    const held = baseHeld()
    const wire = encode({
      id: newBookingEventId(),
      type: "Held",
      bookingId: held.id,
      version: 1,
      occurredAt: at("2026-05-09T11:00:00Z"),
      recordedAt: at("2026-05-09T11:00:00Z"),
      bookingCode: held.code,
      serviceId: held.serviceId,
      providerId: held.providerId,
      resourceIds: held.resourceIds,
      slot: held.slot,
    })
    const round = upcastToLatest(wire)
    expect(round.type).toBe("Held")
    expect(round.version).toBe(1)
  })

  it("rejects an event payload that does not match the latest schema", () => {
    expect(() => upcastToLatest({ type: "Bogus" })).toThrow()
  })

  it("upcastWith folds the supplied chain in order before decoding", () => {
    const held = baseHeld()
    const wire = encode({
      id: newBookingEventId(),
      type: "Held",
      bookingId: held.id,
      version: 1,
      occurredAt: at("2026-05-09T11:00:00Z"),
      recordedAt: at("2026-05-09T11:00:00Z"),
      bookingCode: held.code,
      serviceId: held.serviceId,
      providerId: held.providerId,
      resourceIds: held.resourceIds,
      slot: held.slot,
    })
    // A no-op upcaster — once a real v1→v2 upgrader exists, this
    // pattern is what tests will use to assert the chain runs in
    // order and the decoder accepts the upgraded shape.
    const identity: Upcaster<unknown, unknown> = (e) => e
    const round = upcastWith([identity, identity], wire)
    expect(round.type).toBe("Held")
  })
})

describe("VersionedCodec registry", () => {
  it("lookupCodec(1) returns the v1 entry", () => {
    const codec = lookupCodec(1)
    expect(codec).toBeDefined()
    expect(codec?.version).toBe(1)
  })

  it("lookupCodec(99) is undefined for unregistered versions", () => {
    expect(lookupCodec(99)).toBeUndefined()
  })

  it("upcastFrom(1, raw) ≡ upcastToLatest(raw) for v1 events", () => {
    const held = baseHeld()
    const wire = encode({
      id: newBookingEventId(),
      type: "Held",
      bookingId: held.id,
      version: 1,
      occurredAt: at("2026-05-09T11:00:00Z"),
      recordedAt: at("2026-05-09T11:00:00Z"),
      bookingCode: held.code,
      serviceId: held.serviceId,
      providerId: held.providerId,
      resourceIds: held.resourceIds,
      slot: held.slot,
    })
    const fromV1 = upcastFrom(1, wire)
    const fromLatest = upcastToLatest(wire)
    expect(fromV1).toEqual(fromLatest)
  })

  it("upcastFrom throws on an unregistered version", () => {
    expect(() => upcastFrom(99, {})).toThrow(/no codec registered for version 99/)
  })

  it("upcastFrom propagates schema decode failures", () => {
    expect(() => upcastFrom(1, { type: "Bogus" })).toThrow()
  })
})
