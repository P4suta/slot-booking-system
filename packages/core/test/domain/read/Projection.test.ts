import * as fc from "fast-check"
import { describe, expect, it } from "vitest"
import type { BookingEvent } from "../../../src/domain/events/BookingEvent.js"
import { bookingProjection, dimap, lmap, rmap } from "../../../src/domain/read/projection.js"
import { newBookingEventId } from "../../../src/domain/types/EntityId.js"
import { at, baseHeld } from "../../_fixtures/index.js"

const heldSeed = baseHeld()

const cancelEvent: BookingEvent = {
  id: newBookingEventId(),
  type: "Cancelled",
  bookingId: heldSeed.id,
  version: 1,
  occurredAt: at("2026-05-08T10:00:00Z"),
  recordedAt: at("2026-05-08T10:00:00Z"),
  reason: "test",
  by: "customer",
}

const confirmEvent: BookingEvent = {
  id: newBookingEventId(),
  type: "Confirmed",
  bookingId: heldSeed.id,
  version: 1,
  occurredAt: at("2026-05-08T11:00:00Z"),
  recordedAt: at("2026-05-08T11:00:00Z"),
}

const arbEventList = fc.constantFrom([cancelEvent], [confirmEvent], [confirmEvent, cancelEvent])

describe("Projection — Profunctor laws", () => {
  it("identity: dimap(p, x⇒x, x⇒x) ≡ p (property)", () => {
    fc.assert(
      fc.property(arbEventList, (events) => {
        const idE = (e: BookingEvent): BookingEvent => e
        const idV = (v: ReturnType<typeof bookingProjection.run>) => v
        const lhs = dimap(bookingProjection, idE, idV).run(heldSeed, events)
        const rhs = bookingProjection.run(heldSeed, events)
        return JSON.stringify(lhs) === JSON.stringify(rhs)
      }),
    )
  })

  it("composition: dimap(p, f1∘f2, g2∘g1) ≡ dimap(dimap(p, f1, g1), f2, g2) (property)", () => {
    fc.assert(
      fc.property(arbEventList, (events) => {
        const f1 = (e: BookingEvent): BookingEvent => e
        const f2 = (e: BookingEvent): BookingEvent => e
        const g1 = (s: string): string => `${s}/g1`
        const g2 = (s: string): string => `${s}/g2`
        const stringify = (v: ReturnType<typeof bookingProjection.run>) => v.state
        const base = rmap(bookingProjection, stringify)
        const lhs = dimap(
          base,
          (x: BookingEvent) => f1(f2(x)),
          (s) => g2(g1(s)),
        ).run(heldSeed, events)
        const rhs = dimap(dimap(base, f1, g1), f2, g2).run(heldSeed, events)
        return lhs === rhs
      }),
    )
  })

  it("lmap(p, id) ≡ p", () => {
    const events = [confirmEvent]
    const lhs = lmap(bookingProjection, (e: BookingEvent) => e).run(heldSeed, events)
    const rhs = bookingProjection.run(heldSeed, events)
    expect(JSON.stringify(lhs)).toBe(JSON.stringify(rhs))
  })

  it("rmap(p, id) ≡ p", () => {
    const events = [confirmEvent]
    const lhs = rmap(bookingProjection, (v) => v).run(heldSeed, events)
    const rhs = bookingProjection.run(heldSeed, events)
    expect(JSON.stringify(lhs)).toBe(JSON.stringify(rhs))
  })

  it("rmap composes with bookingProjection for serialisation", () => {
    const stateOf = rmap(bookingProjection, (v) => v.state)
    expect(stateOf.run(heldSeed, [confirmEvent])).toBe("Confirmed")
    expect(stateOf.run(heldSeed, [cancelEvent])).toBe("Cancelled")
  })
})
