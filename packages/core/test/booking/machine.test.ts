import { Either } from "effect"
import { describe, expect, it } from "vitest"
import type { Command } from "../../src/domain/booking/Command.js"
import {
  type BookingMachineEventType,
  type BookingMachineState,
  machineAllows,
  machineNext,
  TERMINAL,
  TRANSITIONS,
} from "../../src/domain/booking/machine.js"
import { apply } from "../../src/domain/booking/transitions.js"
import { newBookingEventId } from "../../src/domain/types/EntityId.js"
import { at, baseHeld, customerCap, slot, staffCap, systemExpire } from "../_fixtures/index.js"

const commandFor = (kind: BookingMachineEventType): Command => {
  switch (kind) {
    case "Confirm":
      return { kind: "Confirm", at: at("2026-05-09T12:01:00Z") }
    case "Cancel":
      return {
        kind: "Cancel",
        at: at("2026-05-09T12:01:00Z"),
        reason: "test",
        capability: customerCap(),
      }
    case "Expire":
      return { kind: "Expire", at: at("2026-05-09T12:05:00Z"), capability: systemExpire() }
    case "Reschedule":
      return {
        kind: "Reschedule",
        at: at("2026-05-09T12:01:00Z"),
        newSlot: slot("2026-05-11T01:00:00Z", "2026-05-11T02:00:00Z"),
        capability: customerCap(),
      }
    case "Complete":
      return { kind: "Complete", at: at("2026-05-10T03:00:00Z"), capability: staffCap() }
    case "MarkNoShow":
      return { kind: "MarkNoShow", at: at("2026-05-10T03:00:00Z"), capability: staffCap() }
  }
}

const STATES: readonly BookingMachineState[] = [
  "Held",
  "Confirmed",
  "Cancelled",
  "Completed",
  "NoShow",
]
const EVENTS: readonly BookingMachineEventType[] = [
  "Confirm",
  "Cancel",
  "Expire",
  "Reschedule",
  "Complete",
  "MarkNoShow",
]

const buildBookingInState = (state: BookingMachineState): ReturnType<typeof baseHeld> | null => {
  if (state === "Held") return baseHeld()
  // Build a Confirmed by walking Held → Confirmed.
  const ev = newBookingEventId
  const r1 = apply(baseHeld(), { kind: "Confirm", at: at("2026-05-09T12:01:00Z") }, ev())
  if (Either.isLeft(r1)) return null
  if (state === "Confirmed") return r1.right.booking as ReturnType<typeof baseHeld>
  if (state === "Cancelled") {
    const r2 = apply(
      r1.right.booking,
      {
        kind: "Cancel",
        at: at("2026-05-09T13:00:00Z"),
        reason: "t",
        capability: customerCap(),
      },
      ev(),
    )
    return Either.isRight(r2) ? (r2.right.booking as ReturnType<typeof baseHeld>) : null
  }
  if (state === "Completed") {
    const r2 = apply(
      r1.right.booking,
      { kind: "Complete", at: at("2026-05-10T03:00:00Z"), capability: staffCap() },
      ev(),
    )
    return Either.isRight(r2) ? (r2.right.booking as ReturnType<typeof baseHeld>) : null
  }
  // NoShow
  const r2 = apply(
    r1.right.booking,
    { kind: "MarkNoShow", at: at("2026-05-10T03:00:00Z"), capability: staffCap() },
    newBookingEventId(),
  )
  return Either.isRight(r2) ? (r2.right.booking as ReturnType<typeof baseHeld>) : null
}

describe("TRANSITIONS spec vs apply (cross-validation)", () => {
  it("the spec exposes exactly 5 states", () => {
    const ids = Object.keys(TRANSITIONS)
    expect(ids.sort()).toEqual([...STATES].sort())
  })

  it("TERMINAL marks Cancelled / Completed / NoShow as terminal, others as live", () => {
    expect(TERMINAL.Held).toBe(false)
    expect(TERMINAL.Confirmed).toBe(false)
    expect(TERMINAL.Cancelled).toBe(true)
    expect(TERMINAL.Completed).toBe(true)
    expect(TERMINAL.NoShow).toBe(true)
  })

  it("terminal states have no outgoing transitions", () => {
    for (const state of STATES) {
      if (TERMINAL[state]) {
        expect(Object.keys(TRANSITIONS[state])).toEqual([])
      }
    }
  })

  it("machineNext returns null for an undefined (state, event) pair", () => {
    expect(machineNext("Held", "Complete")).toBeNull()
    expect(machineNext("Cancelled", "Confirm")).toBeNull()
  })

  it("for every (state, event), the machine's verdict matches `apply`'s success/failure", () => {
    for (const state of STATES) {
      const booking = buildBookingInState(state)
      if (booking === null) {
        throw new Error(`could not construct fixture booking in state ${state}`)
      }
      for (const eventType of EVENTS) {
        const result = apply(booking, commandFor(eventType), newBookingEventId())
        const applyAccepts = Either.isRight(result)
        const machineAccepts = machineAllows(state, eventType)
        expect(applyAccepts, `(${state}, ${eventType}) drift`).toBe(machineAccepts)
        if (applyAccepts && Either.isRight(result)) {
          const expected = machineNext(state, eventType)
          expect(result.right.booking.state).toBe(expected)
        }
      }
    }
  })
})
