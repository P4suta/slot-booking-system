import { Either } from "effect"
import * as fc from "fast-check"
import { describe, expect, it } from "vitest"
import type { Booking, Confirmed } from "../../src/domain/booking/Booking.js"
import type { Command } from "../../src/domain/booking/Command.js"
import { apply } from "../../src/domain/booking/transitions.js"
import { type BookingEventId, newBookingEventId } from "../../src/domain/types/EntityId.js"
import { at, baseHeld, slot } from "../_fixtures/index.js"

const ev = (): BookingEventId => newBookingEventId()

const expectRight = <A, E>(e: Either.Either<A, E>): A => {
  if (Either.isLeft(e)) {
    throw new Error(`expected Right, got Left: ${JSON.stringify(e.left)}`)
  }
  return e.right
}

const expectLeftTag = <E extends { _tag: string }>(
  e: Either.Either<unknown, E>,
  tag: string,
): void => {
  expect(Either.isLeft(e)).toBe(true)
  if (Either.isLeft(e)) expect(e.left._tag).toBe(tag)
}

describe("apply (transitions)", () => {
  describe("Held + Confirm → Confirmed", () => {
    it("returns Confirmed with the same common fields and a Confirmed event", () => {
      const initial = baseHeld()
      const cmd: Command = { kind: "Confirm", at: at("2026-05-09T12:01:00Z") }
      const r = expectRight(apply(initial, cmd, ev()))
      expect(r.booking.state).toBe("Confirmed")
      if (r.booking.state === "Confirmed") {
        expect(r.booking.confirmedAt.equals(cmd.at)).toBe(true)
      }
      expect(r.event.type).toBe("Confirmed")
      expect(r.event.bookingId).toBe(initial.id)
    })
  })

  describe("Held + Cancel → Cancelled", () => {
    it("preserves cancelledBy and reason, emits Cancelled event", () => {
      const cmd: Command = {
        kind: "Cancel",
        at: at("2026-05-09T12:01:00Z"),
        reason: "test",
        by: "customer",
      }
      const r = expectRight(apply(baseHeld(), cmd, ev()))
      expect(r.booking.state).toBe("Cancelled")
      if (r.booking.state === "Cancelled") {
        expect(r.booking.cancelledBy).toBe("customer")
        expect(r.booking.reason).toBe("test")
      }
      expect(r.event.type).toBe("Cancelled")
    })
  })

  describe("Held + Expire → Cancelled by=system", () => {
    it("annotates the cancellation as system-driven", () => {
      const cmd: Command = { kind: "Expire", at: at("2026-05-09T12:05:00Z") }
      const r = expectRight(apply(baseHeld(), cmd, ev()))
      expect(r.booking.state).toBe("Cancelled")
      if (r.booking.state === "Cancelled") {
        expect(r.booking.cancelledBy).toBe("system")
      }
    })
  })

  describe("Held + invalid commands", () => {
    const heldRejects: Command["kind"][] = ["Reschedule", "Complete", "MarkNoShow"]
    it.each(heldRejects)("rejects %s on Held", (kind) => {
      const cmd: Command =
        kind === "Reschedule"
          ? {
              kind: "Reschedule",
              at: at("2026-05-09T12:01:00Z"),
              newSlot: slot("2026-05-10T03:00:00Z", "2026-05-10T04:00:00Z"),
            }
          : kind === "Complete"
            ? { kind: "Complete", at: at("2026-05-09T12:01:00Z") }
            : { kind: "MarkNoShow", at: at("2026-05-09T12:01:00Z"), by: "staff" }
      expectLeftTag(apply(baseHeld(), cmd, ev()), "InvalidStateTransition")
    })
  })

  describe("Confirmed + Reschedule", () => {
    it("preserves confirmedAt, updates slot, emits Rescheduled with from/to", () => {
      const confirmed = expectRight(
        apply(baseHeld(), { kind: "Confirm", at: at("2026-05-09T12:01:00Z") }, ev()),
      ).booking as Confirmed
      const newSlot = slot("2026-05-11T01:00:00Z", "2026-05-11T02:00:00Z")
      const cmd: Command = {
        kind: "Reschedule",
        at: at("2026-05-09T13:00:00Z"),
        newSlot,
      }
      const r = expectRight(apply(confirmed, cmd, ev()))
      expect(r.booking.state).toBe("Confirmed")
      if (r.booking.state === "Confirmed") {
        expect(r.booking.confirmedAt.equals(confirmed.confirmedAt)).toBe(true)
        expect(r.booking.slot.start.equals(newSlot.start)).toBe(true)
      }
      expect(r.event.type).toBe("Rescheduled")
    })
  })

  describe("Confirmed + Complete / MarkNoShow / Cancel", () => {
    it("Complete moves to Completed", () => {
      const confirmed = expectRight(
        apply(baseHeld(), { kind: "Confirm", at: at("2026-05-09T12:01:00Z") }, ev()),
      ).booking as Confirmed
      const r = expectRight(
        apply(confirmed, { kind: "Complete", at: at("2026-05-10T03:00:00Z") }, ev()),
      )
      expect(r.booking.state).toBe("Completed")
      expect(r.event.type).toBe("Completed")
    })

    it("MarkNoShow moves to NoShow", () => {
      const confirmed = expectRight(
        apply(baseHeld(), { kind: "Confirm", at: at("2026-05-09T12:01:00Z") }, ev()),
      ).booking as Confirmed
      const r = expectRight(
        apply(confirmed, { kind: "MarkNoShow", at: at("2026-05-10T03:00:00Z"), by: "staff" }, ev()),
      )
      expect(r.booking.state).toBe("NoShow")
      expect(r.event.type).toBe("NoShow")
    })

    it("Cancel moves to Cancelled", () => {
      const confirmed = expectRight(
        apply(baseHeld(), { kind: "Confirm", at: at("2026-05-09T12:01:00Z") }, ev()),
      ).booking as Confirmed
      const r = expectRight(
        apply(
          confirmed,
          {
            kind: "Cancel",
            at: at("2026-05-09T13:00:00Z"),
            reason: "test",
            by: "customer",
          },
          ev(),
        ),
      )
      expect(r.booking.state).toBe("Cancelled")
    })
  })

  describe("terminal states reject every command", () => {
    const terminals = ["Cancelled", "Completed", "NoShow"] as const
    const tagFor = {
      Cancelled: "AlreadyCancelled",
      Completed: "AlreadyCompleted",
      NoShow: "AlreadyNoShow",
    } as const
    const cmds: Command[] = [
      { kind: "Confirm", at: at("2026-05-09T12:01:00Z") },
      {
        kind: "Cancel",
        at: at("2026-05-09T12:01:00Z"),
        reason: "x",
        by: "customer",
      },
      {
        kind: "Reschedule",
        at: at("2026-05-09T12:01:00Z"),
        newSlot: slot("2026-05-12T01:00:00Z", "2026-05-12T02:00:00Z"),
      },
      { kind: "Complete", at: at("2026-05-09T12:01:00Z") },
      { kind: "MarkNoShow", at: at("2026-05-09T12:01:00Z"), by: "staff" },
      { kind: "Expire", at: at("2026-05-09T12:01:00Z") },
    ]

    for (const tState of terminals) {
      for (const cmd of cmds) {
        it(`${tState} + ${cmd.kind}`, () => {
          // Build a terminal booking from a confirmed via the right path.
          const confirmed = expectRight(
            apply(baseHeld(), { kind: "Confirm", at: at("2026-05-09T12:01:00Z") }, ev()),
          ).booking as Confirmed
          let terminal: Booking
          switch (tState) {
            case "Cancelled":
              terminal = expectRight(
                apply(
                  confirmed,
                  {
                    kind: "Cancel",
                    at: at("2026-05-09T13:00:00Z"),
                    reason: "t",
                    by: "customer",
                  },
                  ev(),
                ),
              ).booking
              break
            case "Completed":
              terminal = expectRight(
                apply(confirmed, { kind: "Complete", at: at("2026-05-10T03:00:00Z") }, ev()),
              ).booking
              break
            case "NoShow":
              terminal = expectRight(
                apply(
                  confirmed,
                  { kind: "MarkNoShow", at: at("2026-05-10T03:00:00Z"), by: "staff" },
                  ev(),
                ),
              ).booking
              break
          }
          expectLeftTag(apply(terminal, cmd, ev()), tagFor[tState])
        })
      }
    }
  })

  describe("stateful property: random command sequences", () => {
    it("invariants hold over arbitrary sequences", () => {
      type World = { booking: Booking; eventCount: number }
      const arbCmd = fc.oneof(
        fc.constant({
          kind: "Confirm" as const,
          at: at("2026-05-09T12:30:00Z"),
        }),
        fc.constant({
          kind: "Cancel" as const,
          at: at("2026-05-09T12:30:00Z"),
          reason: "t",
          by: "customer" as const,
        }),
        fc.constant({
          kind: "Expire" as const,
          at: at("2026-05-09T13:00:00Z"),
        }),
        fc.constant({
          kind: "Complete" as const,
          at: at("2026-05-10T03:00:00Z"),
        }),
        fc.constant({
          kind: "MarkNoShow" as const,
          at: at("2026-05-10T03:00:00Z"),
          by: "staff" as const,
        }),
        fc.constant({
          kind: "Reschedule" as const,
          at: at("2026-05-09T12:30:00Z"),
          newSlot: slot("2026-05-11T01:00:00Z", "2026-05-11T02:00:00Z"),
        }),
      )
      fc.assert(
        fc.property(fc.array(arbCmd, { maxLength: 12 }), (cmds) => {
          let world: World = { booking: baseHeld(), eventCount: 0 }
          for (const cmd of cmds) {
            const r = apply(world.booking, cmd, ev())
            if (Either.isRight(r)) {
              // Invariant 1: a successful apply emits exactly one event whose
              //              bookingId matches.
              if (r.right.event.bookingId !== world.booking.id) return false
              world = { booking: r.right.booking, eventCount: world.eventCount + 1 }
            }
          }
          // Invariant 2: terminal states are absorbing — once Cancelled /
          //              Completed / NoShow, every further apply is Left.
          if (
            world.booking.state === "Cancelled" ||
            world.booking.state === "Completed" ||
            world.booking.state === "NoShow"
          ) {
            for (const cmd of [
              { kind: "Confirm", at: at("2026-05-12T00:00:00Z") },
              { kind: "Complete", at: at("2026-05-12T00:00:00Z") },
            ] as const) {
              if (Either.isRight(apply(world.booking, cmd, ev()))) return false
            }
          }
          return true
        }),
        { numRuns: 500 },
      )
    })
  })
})
