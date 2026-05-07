import { Result } from "effect"
import * as fc from "fast-check"
import { describe, expect, it } from "vitest"
import type { Booking, Confirmed } from "../../src/domain/booking/Booking.js"
import type { Command } from "../../src/domain/booking/Command.js"
import { apply } from "../../src/domain/booking/transitions.js"
import { type BookingEventId, newBookingEventId } from "../../src/domain/types/EntityId.js"
import { at, baseHeld, customerCap, slot, staffCap, systemExpire } from "../_fixtures/index.js"

const ev = (): BookingEventId => newBookingEventId()

const expectRight = <A, E>(e: Result.Result<A, E>): A => {
  if (Result.isFailure(e)) {
    throw new Error(`expected Right, got Left: ${JSON.stringify(e.failure)}`)
  }
  return e.success
}

const expectLeftTag = <E extends { _tag: string }>(
  e: Result.Result<unknown, E>,
  tag: string,
): void => {
  expect(Result.isFailure(e)).toBe(true)
  if (Result.isFailure(e)) expect(e.failure._tag).toBe(tag)
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
    it("preserves cancelledBy (subjectOf customer cap) and reason, emits Cancelled event", () => {
      const cmd: Command = {
        kind: "Cancel",
        at: at("2026-05-09T12:01:00Z"),
        reason: "test",
        capability: customerCap(),
      }
      const r = expectRight(apply(baseHeld(), cmd, ev()))
      expect(r.booking.state).toBe("Cancelled")
      if (r.booking.state === "Cancelled") {
        expect(r.booking.cancelledBy).toBe("customer")
        expect(r.booking.reason).toBe("test")
      }
      expect(r.event.type).toBe("Cancelled")
    })

    it("staff capability without 'cancel' scope is rejected", () => {
      const cmd: Command = {
        kind: "Cancel",
        at: at("2026-05-09T12:01:00Z"),
        reason: "t",
        capability: staffCap(["complete"]),
      }
      expectLeftTag(apply(baseHeld(), cmd, ev()), "InsufficientCapability")
    })
  })

  describe("Held + Expire → Cancelled by=system", () => {
    it("annotates the cancellation as system-driven", () => {
      const cmd: Command = {
        kind: "Expire",
        at: at("2026-05-09T12:05:00Z"),
        capability: systemExpire(),
      }
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
              capability: customerCap(),
            }
          : kind === "Complete"
            ? { kind: "Complete", at: at("2026-05-09T12:01:00Z"), capability: staffCap() }
            : { kind: "MarkNoShow", at: at("2026-05-09T12:01:00Z"), capability: staffCap() }
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
        capability: customerCap(),
      }
      const r = expectRight(apply(confirmed, cmd, ev()))
      expect(r.booking.state).toBe("Confirmed")
      if (r.booking.state === "Confirmed") {
        expect(r.booking.confirmedAt.equals(confirmed.confirmedAt)).toBe(true)
        expect(r.booking.slot.start.equals(newSlot.start)).toBe(true)
      }
      expect(r.event.type).toBe("Rescheduled")
    })

    it("staff capability missing 'reschedule' scope is rejected", () => {
      const confirmed = expectRight(
        apply(baseHeld(), { kind: "Confirm", at: at("2026-05-09T12:01:00Z") }, ev()),
      ).booking as Confirmed
      const cmd: Command = {
        kind: "Reschedule",
        at: at("2026-05-09T13:00:00Z"),
        newSlot: slot("2026-05-11T01:00:00Z", "2026-05-11T02:00:00Z"),
        capability: staffCap(["cancel"]),
      }
      expectLeftTag(apply(confirmed, cmd, ev()), "InsufficientCapability")
    })
  })

  describe("Confirmed + Complete / MarkNoShow / Cancel", () => {
    it("Complete moves to Completed when staff has 'complete' scope", () => {
      const confirmed = expectRight(
        apply(baseHeld(), { kind: "Confirm", at: at("2026-05-09T12:01:00Z") }, ev()),
      ).booking as Confirmed
      const r = expectRight(
        apply(
          confirmed,
          { kind: "Complete", at: at("2026-05-10T03:00:00Z"), capability: staffCap() },
          ev(),
        ),
      )
      expect(r.booking.state).toBe("Completed")
      expect(r.event.type).toBe("Completed")
    })

    it("Complete is rejected when staff lacks 'complete' scope", () => {
      const confirmed = expectRight(
        apply(baseHeld(), { kind: "Confirm", at: at("2026-05-09T12:01:00Z") }, ev()),
      ).booking as Confirmed
      const cmd: Command = {
        kind: "Complete",
        at: at("2026-05-10T03:00:00Z"),
        capability: staffCap(["cancel"]),
      }
      expectLeftTag(apply(confirmed, cmd, ev()), "InsufficientCapability")
    })

    it("MarkNoShow moves to NoShow when staff has 'noshow' scope", () => {
      const confirmed = expectRight(
        apply(baseHeld(), { kind: "Confirm", at: at("2026-05-09T12:01:00Z") }, ev()),
      ).booking as Confirmed
      const r = expectRight(
        apply(
          confirmed,
          { kind: "MarkNoShow", at: at("2026-05-10T03:00:00Z"), capability: staffCap() },
          ev(),
        ),
      )
      expect(r.booking.state).toBe("NoShow")
      if (r.booking.state === "NoShow") {
        expect(r.booking.markedBy).toBe("staff")
      }
      expect(r.event.type).toBe("NoShow")
    })

    it("Cancel moves to Cancelled (customer cap)", () => {
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
            capability: customerCap(),
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
        capability: customerCap(),
      },
      {
        kind: "Reschedule",
        at: at("2026-05-09T12:01:00Z"),
        newSlot: slot("2026-05-12T01:00:00Z", "2026-05-12T02:00:00Z"),
        capability: customerCap(),
      },
      { kind: "Complete", at: at("2026-05-09T12:01:00Z"), capability: staffCap() },
      { kind: "MarkNoShow", at: at("2026-05-09T12:01:00Z"), capability: staffCap() },
      { kind: "Expire", at: at("2026-05-09T12:01:00Z"), capability: systemExpire() },
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
                    capability: customerCap(),
                  },
                  ev(),
                ),
              ).booking
              break
            case "Completed":
              terminal = expectRight(
                apply(
                  confirmed,
                  { kind: "Complete", at: at("2026-05-10T03:00:00Z"), capability: staffCap() },
                  ev(),
                ),
              ).booking
              break
            case "NoShow":
              terminal = expectRight(
                apply(
                  confirmed,
                  { kind: "MarkNoShow", at: at("2026-05-10T03:00:00Z"), capability: staffCap() },
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

  describe("stateful property: fc.commands model-based test", () => {
    type Real = { booking: Booking; eventCount: number; bookingId: string; confirmedAt?: string }
    type Model = {
      state: Booking["state"]
      eventCount: number
      isTerminal: boolean
    }

    const isTerminal = (s: Booking["state"]): boolean =>
      s === "Cancelled" || s === "Completed" || s === "NoShow"

    /**
     * Each command first mirrors the apply against the real Booking, then
     * lifts both the model and the real forward in lockstep. The Real
     * tracks `confirmedAt` so the "Reschedule preserves confirmedAt"
     * invariant can be checked across moves.
     */
    const makeCommand = (cmd: Command, label: string): fc.Command<Model, Real> => ({
      check: () => true,
      run: (m, r) => {
        const before = r.booking
        const result = apply(before, cmd, ev())
        if (Result.isSuccess(result)) {
          // Invariant: every event is bound to the current bookingId.
          expect(result.success.event.bookingId).toBe(r.bookingId)
          // Invariant: a successful apply never violates terminality.
          expect(m.isTerminal).toBe(false)
          const next = result.success.booking
          // Invariant: id is preserved across every successful transition.
          expect(next.id).toBe(r.bookingId)
          // Invariant: Reschedule preserves confirmedAt when starting from Confirmed.
          if (
            cmd.kind === "Reschedule" &&
            before.state === "Confirmed" &&
            next.state === "Confirmed" &&
            r.confirmedAt !== undefined
          ) {
            expect(next.confirmedAt.toString()).toBe(r.confirmedAt)
          }
          if (next.state === "Confirmed") r.confirmedAt = next.confirmedAt.toString()
          r.booking = next
          r.eventCount += 1
          m.state = next.state
          m.eventCount += 1
          m.isTerminal = isTerminal(next.state)
        } else {
          // Invariant: failure leaves both the booking and event count untouched.
          expect(r.booking).toBe(before)
          // Invariant: terminal state implies any apply must fail.
          if (m.isTerminal) {
            // already covered by the Right branch's negation; nothing to assert here
          }
        }
        // Invariant: model.eventCount tracks real.eventCount one-to-one.
        expect(m.eventCount).toBe(r.eventCount)
      },
      toString: () => label,
    })

    const cmds = fc.commands(
      [
        fc.constant(makeCommand({ kind: "Confirm", at: at("2026-05-09T12:30:00Z") }, "Confirm")),
        fc.constant(
          makeCommand(
            {
              kind: "Cancel",
              at: at("2026-05-09T12:30:00Z"),
              reason: "t",
              capability: customerCap(),
            },
            "Cancel",
          ),
        ),
        fc.constant(
          makeCommand(
            { kind: "Expire", at: at("2026-05-09T13:00:00Z"), capability: systemExpire() },
            "Expire",
          ),
        ),
        fc.constant(
          makeCommand(
            { kind: "Complete", at: at("2026-05-10T03:00:00Z"), capability: staffCap() },
            "Complete",
          ),
        ),
        fc.constant(
          makeCommand(
            { kind: "MarkNoShow", at: at("2026-05-10T03:00:00Z"), capability: staffCap() },
            "MarkNoShow",
          ),
        ),
        fc.constant(
          makeCommand(
            {
              kind: "Reschedule",
              at: at("2026-05-09T12:30:00Z"),
              newSlot: slot("2026-05-11T01:00:00Z", "2026-05-11T02:00:00Z"),
              capability: customerCap(),
            },
            "Reschedule",
          ),
        ),
      ],
      { maxCommands: 12 },
    )

    it("invariants hold for any random sequence of commands", () => {
      fc.assert(
        fc.property(cmds, (sequence) => {
          fc.modelRun(() => {
            const initial = baseHeld()
            const real: Real = { booking: initial, eventCount: 0, bookingId: initial.id }
            const model: Model = {
              state: "Held",
              eventCount: 0,
              isTerminal: false,
            }
            return { model, real }
          }, sequence)
        }),
        { numRuns: 200 },
      )
    })
  })
})
