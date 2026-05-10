import { Temporal } from "@js-temporal/polyfill"
import { Schema } from "effect"
import * as fc from "fast-check"
import { describe, expect, it } from "vitest"
import { firstLaneWithCallable, firstLaneWithWaiting } from "../../src/domain/queue/projection.js"
import type { Ticket } from "../../src/domain/queue/Ticket.js"
import { applyIssue } from "../../src/domain/queue/transitions.js"
import { newTicketEventId, newTicketId, type TicketId } from "../../src/domain/types/EntityId.js"
import { FreeTextSchema } from "../../src/domain/value-objects/FreeText.js"
import { NameKanaSchema } from "../../src/domain/value-objects/NameKana.js"
import { PhoneLast4Schema } from "../../src/domain/value-objects/PhoneLast4.js"
import { numRuns } from "../_arb/numRuns.js"

/**
 * `firstLaneWithCallable` (ADR-0067) is the EDF-augmented chain
 * selector. The four properties below pin its semantics:
 *
 *   - eligibility: a reservation whose appointmentAt is within
 *     `now + grace` wins over priority and walk-in heads.
 *   - non-eligibility: a reservation outside the window does NOT
 *     pre-empt; the chain falls back to ADR-0062's static order.
 *   - boundary at `grace = +∞`: any reservation always wins.
 *   - boundary at `grace = 0` with all `appointmentAt = null`:
 *     identical to {@link firstLaneWithWaiting}.
 */

const kana = Schema.decodeUnknownSync(NameKanaSchema)("ヤマダ タロウ")
const phone = Schema.decodeUnknownSync(PhoneLast4Schema)("1234")
const free = Schema.decodeUnknownSync(FreeTextSchema)("用件")
const NOW = Temporal.Instant.from("2026-05-08T13:55:00Z")
const GRACE_5 = Temporal.Duration.from({ minutes: 5 })
// Temporal.Instant.add only accepts hour / minute / second / sub-
// second units, so "infinite" is encoded as ~100 years in hours.
const GRACE_INF = Temporal.Duration.from({ hours: 876_000 })
const GRACE_0 = Temporal.Duration.from({ seconds: 0 })

const issueOne = (opts: {
  seq: number
  lane: "walkIn" | "priority" | "reservation"
  appointmentAt: Temporal.Instant | null
  idHint?: TicketId
}) => {
  const id = opts.idHint ?? newTicketId()
  return applyIssue({
    id,
    seq: opts.seq,
    lane: opts.lane,
    displaySeq: opts.seq,
    nameKana: kana,
    phoneLast4: phone,
    freeText: free,
    appointmentAt: opts.appointmentAt,
    at: Temporal.Instant.from("2026-05-08T09:00:00Z"),
    eventId: newTicketEventId(),
  })
}

const snapshotOf = (...tickets: readonly Ticket[]) => {
  const map = new Map<TicketId, Ticket>()
  for (const t of tickets) map.set(t.id, t)
  return { tickets: map }
}

const arbInstantInWindow = (windowMin: number): fc.Arbitrary<Temporal.Instant> =>
  fc
    .integer({ min: -windowMin * 60_000, max: windowMin * 60_000 })
    .map((deltaMs) => NOW.add({ milliseconds: deltaMs }))

describe("ADR-0067 firstLaneWithCallable — EDF eligibility", () => {
  it("eligible reservation wins over priority and walkIn heads", () => {
    fc.assert(
      fc.property(
        arbInstantInWindow(4), // appointmentAt within ±4min of NOW (well inside 5min grace)
        (apptAt) => {
          const wkr = issueOne({ seq: 1, lane: "walkIn", appointmentAt: null })
          const prr = issueOne({ seq: 2, lane: "priority", appointmentAt: null })
          const rsv = issueOne({ seq: 3, lane: "reservation", appointmentAt: apptAt })
          const snap = snapshotOf(wkr.ticket, prr.ticket, rsv.ticket)
          expect(firstLaneWithCallable(snap, NOW, GRACE_5)).toBe("reservation")
        },
      ),
      { numRuns: numRuns(50, 200) },
    )
  })

  it("ineligible reservation falls back to the priority-then-walkIn chain", () => {
    fc.assert(
      fc.property(
        // appointmentAt 6..120 minutes in the future — outside 5min grace
        fc.integer({ min: 6, max: 120 }).map((m) => NOW.add({ minutes: m })),
        (apptAt) => {
          const wkr = issueOne({ seq: 1, lane: "walkIn", appointmentAt: null })
          const prr = issueOne({ seq: 2, lane: "priority", appointmentAt: null })
          const rsv = issueOne({ seq: 3, lane: "reservation", appointmentAt: apptAt })
          const snap = snapshotOf(wkr.ticket, prr.ticket, rsv.ticket)
          expect(firstLaneWithCallable(snap, NOW, GRACE_5)).toBe("priority")
        },
      ),
      { numRuns: numRuns(50, 200) },
    )
  })

  it("at grace = +∞ a reservation always wins when present", () => {
    fc.assert(
      fc.property(
        // any appointmentAt (past or future) — Temporal.Instant only
        // accepts hour-level units, so we span a year via hour count.
        fc.integer({ min: -8760, max: 8760 }).map((h) => NOW.add({ hours: h })),
        (apptAt) => {
          const wkr = issueOne({ seq: 1, lane: "walkIn", appointmentAt: null })
          const rsv = issueOne({ seq: 2, lane: "reservation", appointmentAt: apptAt })
          const snap = snapshotOf(wkr.ticket, rsv.ticket)
          expect(firstLaneWithCallable(snap, NOW, GRACE_INF)).toBe("reservation")
        },
      ),
      { numRuns: numRuns(50, 200) },
    )
  })

  it("at grace = 0 with all appointmentAt = null, behaves identically to firstLaneWithWaiting", () => {
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), (hasPriority, hasWalkIn) => {
        const tickets = [
          ...(hasPriority
            ? [issueOne({ seq: 1, lane: "priority", appointmentAt: null }).ticket]
            : []),
          ...(hasWalkIn ? [issueOne({ seq: 2, lane: "walkIn", appointmentAt: null }).ticket] : []),
        ]
        const snap = snapshotOf(...tickets)
        expect(firstLaneWithCallable(snap, NOW, GRACE_0)).toBe(firstLaneWithWaiting(snap))
      }),
      { numRuns: numRuns(50, 200) },
    )
  })

  it("returns null when the snapshot has no Waiting ticket", () => {
    expect(firstLaneWithCallable({ tickets: new Map<TicketId, Ticket>() }, NOW, GRACE_5)).toBeNull()
  })
})
