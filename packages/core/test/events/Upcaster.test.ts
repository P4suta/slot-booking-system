import { Schema } from "effect"
import { describe, expect, expectTypeOf, it } from "vitest"
import { BookingEventSchema } from "../../src/domain/events/BookingEvent.js"
import { type Upcaster, upcastToLatest, upcastWith } from "../../src/domain/events/Upcaster.js"
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
