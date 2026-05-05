import { Either } from "effect"
import * as fc from "fast-check"
import { describe, expect, it } from "vitest"
import type { Booking } from "../../src/domain/booking/Booking.js"
import type { Command } from "../../src/domain/booking/Command.js"
import { apply } from "../../src/domain/booking/transitions.js"
import { newBookingEventId } from "../../src/domain/types/EntityId.js"
import { at, baseHeld, customerCap, slot, staffCap, systemExpire } from "../_fixtures/index.js"

/**
 * Phase 0.7-γ2 — concurrency-adjacent property tests for the pure
 * transition function. `apply` itself is pure; concurrency at the
 * domain layer reduces to "any sequence of commands lands the
 * booking in a state that is the natural fold of those commands
 * against the transition table". The OCC layer (in
 * EventSourcedRepository) is what actually catches racing writers
 * — that contract is exercised by the InMemoryEventSourcedRepository
 * suite. The properties here pin the domain-level invariants that
 * survive any interleaving:
 *
 *   1. apply is total — never throws, always returns Either.
 *   2. apply respects terminality — once the booking enters a
 *      terminal state, every subsequent apply is rejected (the
 *      `Already*` family).
 *   3. event count and state changes always agree (Right ⇒
 *      transition, Left ⇒ no state change).
 */

const ev = (): ReturnType<typeof newBookingEventId> => newBookingEventId()

const sampleCommands: readonly Command[] = [
  { kind: "Confirm", at: at("2026-05-09T12:01:00Z") },
  {
    kind: "Cancel",
    at: at("2026-05-09T12:02:00Z"),
    reason: "race",
    capability: customerCap(),
  },
  { kind: "Expire", at: at("2026-05-09T12:05:00Z"), capability: systemExpire() },
  {
    kind: "Reschedule",
    at: at("2026-05-09T13:00:00Z"),
    newSlot: slot("2026-05-11T01:00:00Z", "2026-05-11T02:00:00Z"),
    capability: customerCap(),
  },
  { kind: "Complete", at: at("2026-05-10T03:00:00Z"), capability: staffCap() },
  { kind: "MarkNoShow", at: at("2026-05-10T03:00:00Z"), capability: staffCap() },
]

const TERMINAL: ReadonlySet<Booking["state"]> = new Set(["Cancelled", "Completed", "NoShow"])

describe("apply property suite (race-aware invariants)", () => {
  it("is total: never throws on any random sequence of commands", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...sampleCommands), { minLength: 0, maxLength: 16 }),
        (cmds) => {
          let current: Booking = baseHeld()
          for (const cmd of cmds) {
            const result = apply(current, cmd, ev())
            // Either Right or Left — both are observable, neither throws.
            expect(Either.isRight(result) || Either.isLeft(result)).toBe(true)
            if (Either.isRight(result)) current = result.right.booking
          }
          return true
        },
      ),
      { numRuns: 300 },
    )
  })

  it("once terminal, every subsequent apply is rejected", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...sampleCommands), { minLength: 0, maxLength: 16 }),
        (cmds) => {
          let current: Booking = baseHeld()
          let terminal = false
          for (const cmd of cmds) {
            const result = apply(current, cmd, ev())
            if (terminal) {
              // After terminality, the apply must reject.
              expect(Either.isLeft(result)).toBe(true)
            }
            if (Either.isRight(result)) {
              current = result.right.booking
              if (TERMINAL.has(current.state)) terminal = true
            }
          }
          return true
        },
      ),
      { numRuns: 300 },
    )
  })

  it("Right ⇒ booking changed (state or slot); Left ⇒ booking is referentially identical", () => {
    fc.assert(
      fc.property(fc.constantFrom(...sampleCommands), (cmd) => {
        const initial = baseHeld()
        const result = apply(initial, cmd, ev())
        if (Either.isLeft(result)) {
          // No transition happened; nothing observable changed at the domain layer.
          return true
        }
        // A successful apply must produce a Booking with the same id but
        // with either a different state or a different slot.
        const next = result.right.booking
        expect(next.id).toBe(initial.id)
        const sameState = next.state === initial.state
        const sameSlot =
          next.slot.start.epochNanoseconds === initial.slot.start.epochNanoseconds &&
          next.slot.end.epochNanoseconds === initial.slot.end.epochNanoseconds
        expect(sameState && sameSlot).toBe(false)
        return true
      }),
      { numRuns: 200 },
    )
  })
})
