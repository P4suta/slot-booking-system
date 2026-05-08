import { Result } from "effect"
import { describe, expect, expectTypeOf, it } from "vitest"
import {
  type Active,
  type Booking,
  type BookingT,
  inState,
  isActive,
  isCancelled,
  isCompleted,
  isConfirmed,
  isHeld,
  isNoShow,
} from "../../src/domain/booking/Booking.js"
import type { Command } from "../../src/domain/booking/Command.js"
import { applyTyped } from "../../src/domain/booking/transitions.js"
import type { BookingEvent } from "../../src/domain/events/BookingEvent.js"
import { newBookingEventId } from "../../src/domain/types/EntityId.js"
import { baseHeld } from "../_fixtures/bookings.js"

/* -------------------------------------------------------------------------- */
/* Type-level: BookingT<S> shrinks Booking to a single state                   */
/* -------------------------------------------------------------------------- */

describe("typestate refinement", () => {
  it("BookingT<S> narrows the Booking union to one variant", () => {
    type Held = BookingT<"Held">
    type Confirmed = BookingT<"Confirmed">
    expectTypeOf<Held["state"]>().toEqualTypeOf<"Held">()
    expectTypeOf<Confirmed["state"]>().toEqualTypeOf<"Confirmed">()
    // Held has expiresAt; Confirmed has confirmedAt — distinct fields.
    expectTypeOf<Held>().toHaveProperty("expiresAt")
    expectTypeOf<Confirmed>().toHaveProperty("confirmedAt")
  })

  it("Active is the disjunction of Held and Confirmed", () => {
    type Expected = BookingT<"Held"> | BookingT<"Confirmed">
    expectTypeOf<Active>().toEqualTypeOf<Expected>()
  })
})

/* -------------------------------------------------------------------------- */
/* Runtime guards                                                              */
/* -------------------------------------------------------------------------- */

describe("typestate guards", () => {
  it("inState(s)(b) discriminates by state literal", () => {
    const b: Booking = baseHeld()
    expect(inState("Held")(b)).toBe(true)
    expect(inState("Confirmed")(b)).toBe(false)
  })

  it("isHeld / isConfirmed / isCancelled / isCompleted / isNoShow partition the union", () => {
    const b: Booking = baseHeld()
    expect([isHeld(b), isConfirmed(b), isCancelled(b), isCompleted(b), isNoShow(b)]).toEqual([
      true,
      false,
      false,
      false,
      false,
    ])
  })

  it("isActive holds for Held (and by parity for Confirmed)", () => {
    const b: Booking = baseHeld()
    expect(isActive(b)).toBe(true)
  })

  it("type guards narrow at the call site", () => {
    const b: Booking = baseHeld()
    if (isHeld(b)) {
      expectTypeOf(b.state).toEqualTypeOf<"Held">()
      // After narrowing, Held-specific fields are accessible without cast.
      expectTypeOf(b).toHaveProperty("expiresAt")
    }
  })
})

/* -------------------------------------------------------------------------- */
/* applyTyped: typestate-encoded transitions                                   */
/* -------------------------------------------------------------------------- */

describe("applyTyped", () => {
  it("the success-side booking is narrowed to the successor state at the type level", () => {
    const b = baseHeld()
    const cmd: Command & { kind: "Confirm" } = { kind: "Confirm", at: b.heldAt }
    const r = applyTyped(b, cmd, newBookingEventId())
    expect(Result.isSuccess(r)).toBe(true)
    if (Result.isSuccess(r)) {
      expectTypeOf(r.success.booking.state).toEqualTypeOf<"Confirmed">()
      expect(r.success.booking.state).toBe("Confirmed")
    }
  })

  it("the success-side event type aligns with the successor", () => {
    const b = baseHeld()
    const cmd: Command & { kind: "Confirm" } = { kind: "Confirm", at: b.heldAt }
    const r = applyTyped(b, cmd, newBookingEventId())
    expect(Result.isSuccess(r)).toBe(true)
    if (Result.isSuccess(r)) {
      const evt: BookingEvent = r.success.event
      expect(evt.type).toBe("Confirmed")
    }
  })
})
