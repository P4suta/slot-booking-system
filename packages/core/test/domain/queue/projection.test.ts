import { Temporal } from "@js-temporal/polyfill"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import type { Lane } from "../../../src/domain/queue/Lane.js"
import {
  applyEvent,
  applyMany,
  callingTickets,
  currentlyServing,
  empty,
  firstLaneWithCallable,
  firstLaneWithWaiting,
  globalPositionOf,
  head,
  headOfLane,
  nextDisplaySeqInLane,
  occupancyExcludingSelf,
  positionOf,
  replay,
  reservationsByDeadline,
  servingTickets,
  slotOccupancy,
  waitingCount,
  waitingTickets,
} from "../../../src/domain/queue/projection.js"
import type { Called, Serving, Waiting } from "../../../src/domain/queue/Ticket.js"
import {
  applyCall,
  applyCancel,
  applyCheckIn,
  applyIssue,
  applyMarkNoShow,
  applyMarkServed,
  applyRecall,
  applyStartServing,
} from "../../../src/domain/queue/transitions.js"
import { newTicketEventId, newTicketId, type TicketId } from "../../../src/domain/types/EntityId.js"
import { BusinessTimeZoneSchema } from "../../../src/domain/value-objects/BusinessTimeZone.js"
import { FreeTextSchema } from "../../../src/domain/value-objects/FreeText.js"
import { NameKanaSchema } from "../../../src/domain/value-objects/NameKana.js"
import { PhoneLast4Schema } from "../../../src/domain/value-objects/PhoneLast4.js"

const at = (iso: string) => Temporal.Instant.from(iso)
const kana = Schema.decodeUnknownSync(NameKanaSchema)("ヤマダ タロウ")
const phone = Schema.decodeUnknownSync(PhoneLast4Schema)("1234")
const free = Schema.decodeUnknownSync(FreeTextSchema)("用件")

const issue = (seq: number, opts?: { lane?: Lane; displaySeq?: number; idHint?: TicketId }) => {
  const id = opts?.idHint ?? newTicketId()
  const lane = opts?.lane ?? "walkIn"
  const displaySeq = opts?.displaySeq ?? seq
  return applyIssue({
    id,
    seq,
    lane,
    displaySeq,
    nameKana: kana,
    phoneLast4: phone,
    freeText: free,
    appointmentAt: null,
    at: at(`2026-05-08T09:0${String(seq)}:00Z`),
    eventId: newTicketEventId(),
  })
}

describe("empty / replay", () => {
  it("empty has no tickets", () => {
    expect(empty.tickets.size).toBe(0)
  })

  it("replay([]) is empty", () => {
    expect(replay([]).tickets.size).toBe(0)
  })

  it("replay applies Issued events", () => {
    const a = issue(1)
    const b = issue(2)
    const snap = replay([a.event, b.event])
    expect(snap.tickets.size).toBe(2)
  })
})

describe("monoid homomorphism", () => {
  it("replay(xs ++ ys) ≡ applyMany(replay(xs), ys)", () => {
    const a = issue(1)
    const b = issue(2)
    const c = issue(3)
    const left = replay([a.event, b.event, c.event])
    const right = applyMany(replay([a.event, b.event]), [c.event])
    expect(left.tickets.size).toBe(right.tickets.size)
    for (const id of left.tickets.keys()) {
      expect(right.tickets.has(id)).toBe(true)
    }
  })
})

describe("derived queries — head / currentlyServing / positionOf / waitingCount", () => {
  it("head returns the lowest-displaySeq Waiting ticket in walkIn (default)", () => {
    const a = issue(1)
    const b = issue(2)
    const snap = replay([b.event, a.event])
    expect(head(snap)?.id).toBe(a.ticket.id)
  })

  it("head returns null when no Waiting ticket exists", () => {
    expect(head(empty)).toBeNull()
  })

  it("waitingCount counts only Waiting tickets", () => {
    const a = issue(1)
    const b = issue(2)
    const c = issue(3)
    const snap = replay([a.event, b.event, c.event])
    expect(waitingCount(snap)).toBe(3)
  })

  it("currentlyServing returns the lowest-displaySeq Called ticket", () => {
    const a = issue(1)
    const callA = applyCall(a.ticket as Waiting, {
      at: at("2026-05-08T09:05:00Z"),
      eventId: newTicketEventId(),
    })
    const snap = replay([a.event, callA.event])
    expect(currentlyServing(snap)?.id).toBe(a.ticket.id)
  })

  it("currentlyServing returns null after the Called ticket transitions to Served", () => {
    const a = issue(1)
    const callA = applyCall(a.ticket as Waiting, {
      at: at("2026-05-08T09:05:00Z"),
      eventId: newTicketEventId(),
    })
    const served = applyMarkServed(
      callA.ticket as Called,
      at("2026-05-08T09:10:00Z"),
      newTicketEventId(),
    )
    const snap = replay([a.event, callA.event, served.event])
    expect(currentlyServing(snap)).toBeNull()
  })

  it("currentlyServing returns Serving tickets too (ADR-0063 customer view)", () => {
    const a = issue(1)
    const callA = applyCall(a.ticket as Waiting, {
      at: at("2026-05-08T09:05:00Z"),
      eventId: newTicketEventId(),
    })
    const serving = applyStartServing(
      callA.ticket as Called,
      at("2026-05-08T09:07:00Z"),
      newTicketEventId(),
    )
    const snap = replay([a.event, callA.event, serving.event])
    const cs = currentlyServing(snap)
    expect(cs?.state).toBe("Serving")
  })

  it("positionOf reports the number of waiting tickets ahead in the same lane", () => {
    const a = issue(1)
    const b = issue(2)
    const c = issue(3)
    const snap = replay([a.event, b.event, c.event])
    expect(positionOf(snap, a.ticket.id)).toBe(0)
    expect(positionOf(snap, b.ticket.id)).toBe(1)
    expect(positionOf(snap, c.ticket.id)).toBe(2)
  })

  it("positionOf returns null for a non-Waiting ticket", () => {
    const a = issue(1)
    const callA = applyCall(a.ticket as Waiting, {
      at: at("2026-05-08T09:05:00Z"),
      eventId: newTicketEventId(),
    })
    const snap = replay([a.event, callA.event])
    expect(positionOf(snap, a.ticket.id)).toBeNull()
  })

  it("positionOf returns null for an unknown ticket", () => {
    expect(positionOf(empty, newTicketId())).toBeNull()
  })

  it("head skips non-Waiting tickets in a mixed-state snapshot", () => {
    const a = issue(1)
    const b = issue(2)
    const callA = applyCall(a.ticket as Waiting, {
      at: at("2026-05-08T09:05:00Z"),
      eventId: newTicketEventId(),
    })
    const snap = replay([a.event, b.event, callA.event])
    expect(head(snap)?.id).toBe(b.ticket.id)
  })

  it("currentlyServing skips non-Called tickets in a mixed-state snapshot", () => {
    const a = issue(1)
    const b = issue(2)
    const callA = applyCall(a.ticket as Waiting, {
      at: at("2026-05-08T09:05:00Z"),
      eventId: newTicketEventId(),
    })
    const snap = replay([a.event, b.event, callA.event])
    expect(currentlyServing(snap)?.id).toBe(a.ticket.id)
  })

  it("positionOf skips non-Waiting tickets when counting ahead", () => {
    const a = issue(1)
    const b = issue(2)
    const c = issue(3)
    const callA = applyCall(a.ticket as Waiting, {
      at: at("2026-05-08T09:05:00Z"),
      eventId: newTicketEventId(),
    })
    const snap = replay([a.event, b.event, c.event, callA.event])
    expect(positionOf(snap, b.ticket.id)).toBe(0)
    expect(positionOf(snap, c.ticket.id)).toBe(1)
  })

  it("currentlyServing picks the lowest-displaySeq Called ticket in a multi-Called snapshot", () => {
    const a = issue(1)
    const b = issue(2)
    const callA = applyCall(a.ticket as Waiting, {
      at: at("2026-05-08T09:05:00Z"),
      eventId: newTicketEventId(),
    })
    const callB = applyCall(b.ticket as Waiting, {
      at: at("2026-05-08T09:06:00Z"),
      eventId: newTicketEventId(),
    })
    const snap = replay([a.event, b.event, callA.event, callB.event])
    expect(currentlyServing(snap)?.id).toBe(a.ticket.id)
  })
})

describe("lane-aware queries (ADR-0062 / ADR-0065)", () => {
  it("head with no lane follows the preferred chain priority > walkIn > reservation", () => {
    const w = issue(1, { lane: "walkIn", displaySeq: 1 })
    const p = issue(2, { lane: "priority", displaySeq: 1 })
    const r = issue(3, { lane: "reservation", displaySeq: 1 })
    const snap = replay([w.event, p.event, r.event])
    expect(head(snap)?.id).toBe(p.ticket.id)
  })

  it("head with explicit lane returns that lane's head only", () => {
    const w1 = issue(1, { lane: "walkIn", displaySeq: 1 })
    const w2 = issue(2, { lane: "walkIn", displaySeq: 2 })
    const r = issue(3, { lane: "reservation", displaySeq: 1 })
    const snap = replay([w1.event, w2.event, r.event])
    expect(head(snap, "walkIn")?.id).toBe(w1.ticket.id)
    expect(head(snap, "reservation")?.id).toBe(r.ticket.id)
    expect(head(snap, "priority")).toBeNull()
  })

  it("headOfLane is null when the lane is empty even if other lanes have waiters", () => {
    const w = issue(1, { lane: "walkIn", displaySeq: 1 })
    const snap = replay([w.event])
    expect(headOfLane(snap, "priority")).toBeNull()
    expect(headOfLane(snap, "walkIn")?.id).toBe(w.ticket.id)
  })

  it("firstLaneWithWaiting returns null when every lane is empty", () => {
    expect(firstLaneWithWaiting(empty)).toBeNull()
  })

  it("firstLaneWithWaiting reflects the preferred chain order", () => {
    const w = issue(1, { lane: "walkIn", displaySeq: 1 })
    const r = issue(2, { lane: "reservation", displaySeq: 1 })
    const snap1 = replay([w.event])
    expect(firstLaneWithWaiting(snap1)).toBe("walkIn")
    const snap2 = replay([w.event, r.event])
    expect(firstLaneWithWaiting(snap2)).toBe("walkIn")
    const p = issue(3, { lane: "priority", displaySeq: 1 })
    const snap3 = replay([w.event, r.event, p.event])
    expect(firstLaneWithWaiting(snap3)).toBe("priority")
  })

  it("waitingCount accepts an optional lane filter", () => {
    const w1 = issue(1, { lane: "walkIn", displaySeq: 1 })
    const w2 = issue(2, { lane: "walkIn", displaySeq: 2 })
    const p = issue(3, { lane: "priority", displaySeq: 1 })
    const snap = replay([w1.event, w2.event, p.event])
    expect(waitingCount(snap)).toBe(3)
    expect(waitingCount(snap, "walkIn")).toBe(2)
    expect(waitingCount(snap, "priority")).toBe(1)
    expect(waitingCount(snap, "reservation")).toBe(0)
  })

  it("waitingTickets returns the lane's Waiting tickets sorted by displaySeq", () => {
    const a = issue(3, { lane: "walkIn", displaySeq: 3 })
    const b = issue(1, { lane: "walkIn", displaySeq: 1 })
    const c = issue(2, { lane: "walkIn", displaySeq: 2 })
    const snap = replay([a.event, b.event, c.event])
    const order = waitingTickets(snap, "walkIn").map((t) => t.id)
    expect(order).toEqual([b.ticket.id, c.ticket.id, a.ticket.id])
  })

  it("waitingTickets without lane returns every lane's Waiting (sorted by displaySeq globally)", () => {
    const a = issue(1, { lane: "walkIn", displaySeq: 5 })
    const b = issue(2, { lane: "priority", displaySeq: 1 })
    const snap = replay([a.event, b.event])
    const ids = waitingTickets(snap).map((t) => t.id)
    expect(ids).toContain(a.ticket.id)
    expect(ids).toContain(b.ticket.id)
  })

  it("waitingTickets skips non-Waiting tickets in a mixed-state snapshot", () => {
    // A ticket that has been Called must not appear in waitingTickets
    // even when the lane filter matches.
    const a = issue(1, { lane: "walkIn", displaySeq: 1 })
    const b = issue(2, { lane: "walkIn", displaySeq: 2 })
    const callA = applyCall(a.ticket as Waiting, {
      at: at("2026-05-08T09:05:00Z"),
      eventId: newTicketEventId(),
    })
    const snap = replay([a.event, b.event, callA.event])
    expect(waitingTickets(snap, "walkIn").map((t) => t.id)).toEqual([b.ticket.id])
    expect(waitingTickets(snap).map((t) => t.id)).toEqual([b.ticket.id])
  })

  it("waitingTickets with lane filter excludes tickets from other lanes", () => {
    const w = issue(1, { lane: "walkIn", displaySeq: 1 })
    const p = issue(2, { lane: "priority", displaySeq: 1 })
    const snap = replay([w.event, p.event])
    const priorityOnly = waitingTickets(snap, "priority").map((t) => t.id)
    expect(priorityOnly).toEqual([p.ticket.id])
    const walkInOnly = waitingTickets(snap, "walkIn").map((t) => t.id)
    expect(walkInOnly).toEqual([w.ticket.id])
  })

  it("nextDisplaySeqInLane updates max as it scans (priority + walkIn coexist)", () => {
    const a = issue(1, { lane: "walkIn", displaySeq: 3 })
    const b = issue(2, { lane: "walkIn", displaySeq: 1 })
    const c = issue(3, { lane: "walkIn", displaySeq: 5 })
    const p = issue(4, { lane: "priority", displaySeq: 9 })
    const snap = replay([a.event, b.event, c.event, p.event])
    expect(nextDisplaySeqInLane(snap, "walkIn")).toBe(6)
    expect(nextDisplaySeqInLane(snap, "priority")).toBe(10)
  })

  it("servingTickets sorts by displaySeq across multiple Serving variants", () => {
    const a = issue(1, { lane: "walkIn", displaySeq: 2 })
    const b = issue(2, { lane: "walkIn", displaySeq: 1 })
    const ca = applyCall(a.ticket as Waiting, {
      at: at("2026-05-08T09:05:00Z"),
      eventId: newTicketEventId(),
    })
    const cb = applyCall(b.ticket as Waiting, {
      at: at("2026-05-08T09:06:00Z"),
      eventId: newTicketEventId(),
    })
    const sa = applyStartServing(
      ca.ticket as Called,
      at("2026-05-08T09:07:00Z"),
      newTicketEventId(),
    )
    const sb = applyStartServing(
      cb.ticket as Called,
      at("2026-05-08T09:08:00Z"),
      newTicketEventId(),
    )
    const snap = replay([a.event, b.event, ca.event, cb.event, sa.event, sb.event])
    const order = servingTickets(snap).map((t) => t.id)
    expect(order).toEqual([b.ticket.id, a.ticket.id])
  })

  it("callingTickets / servingTickets honour lane filter against cross-lane peers", () => {
    const w = issue(1, { lane: "walkIn", displaySeq: 1 })
    const p = issue(2, { lane: "priority", displaySeq: 1 })
    const cw = applyCall(w.ticket as Waiting, {
      at: at("2026-05-08T09:05:00Z"),
      eventId: newTicketEventId(),
    })
    const cp = applyCall(p.ticket as Waiting, {
      at: at("2026-05-08T09:06:00Z"),
      eventId: newTicketEventId(),
    })
    const snap = replay([w.event, p.event, cw.event, cp.event])
    expect(callingTickets(snap, "walkIn").map((t) => t.id)).toEqual([w.ticket.id])
    expect(callingTickets(snap, "priority").map((t) => t.id)).toEqual([p.ticket.id])
    const sw = applyStartServing(
      cw.ticket as Called,
      at("2026-05-08T09:07:00Z"),
      newTicketEventId(),
    )
    const snap2 = replay([w.event, p.event, cw.event, cp.event, sw.event])
    expect(servingTickets(snap2, "walkIn").map((t) => t.id)).toEqual([w.ticket.id])
    expect(servingTickets(snap2, "priority").map((t) => t.id)).toEqual([])
  })

  it("positionOf scopes counts to the ticket's own lane (cross-lane peers ignored)", () => {
    const w1 = issue(1, { lane: "walkIn", displaySeq: 1 })
    const w2 = issue(2, { lane: "walkIn", displaySeq: 2 })
    const p1 = issue(3, { lane: "priority", displaySeq: 1 })
    const snap = replay([w1.event, w2.event, p1.event])
    // w2 is second in walkIn; the priority peer p1 must not count.
    expect(positionOf(snap, w2.ticket.id)).toBe(1)
    expect(positionOf(snap, p1.ticket.id)).toBe(0)
  })

  it("globalPositionOf skips Called/Serving peers in the target's own lane", () => {
    // Called peer in same lane as target should NOT count toward
    // the customer-facing position.
    const head = issue(1, { lane: "walkIn", displaySeq: 1 })
    const target = issue(2, { lane: "walkIn", displaySeq: 2 })
    const callHead = applyCall(head.ticket as Waiting, {
      at: at("2026-05-08T09:05:00Z"),
      eventId: newTicketEventId(),
    })
    const snap = replay([head.event, target.event, callHead.event])
    // Once `head` is Called, target is at position 0 inside walkIn
    // (no Waiting peer ahead) and 0 in upstream lanes (none).
    expect(globalPositionOf(snap, target.ticket.id)).toBe(0)
  })

  it("callingTickets returns only Called variants, sorted by displaySeq", () => {
    const a = issue(1)
    const b = issue(2)
    const ca = applyCall(a.ticket as Waiting, {
      at: at("2026-05-08T09:05:00Z"),
      eventId: newTicketEventId(),
    })
    const cb = applyCall(b.ticket as Waiting, {
      at: at("2026-05-08T09:06:00Z"),
      eventId: newTicketEventId(),
    })
    const snap = replay([a.event, b.event, ca.event, cb.event])
    expect(callingTickets(snap).map((t) => t.id)).toEqual([a.ticket.id, b.ticket.id])
  })

  it("servingTickets returns only Serving variants", () => {
    const a = issue(1)
    const ca = applyCall(a.ticket as Waiting, {
      at: at("2026-05-08T09:05:00Z"),
      eventId: newTicketEventId(),
    })
    const sa = applyStartServing(
      ca.ticket as Called,
      at("2026-05-08T09:07:00Z"),
      newTicketEventId(),
    )
    const snap = replay([a.event, ca.event, sa.event])
    expect(servingTickets(snap).map((t) => t.id)).toEqual([a.ticket.id])
    expect(callingTickets(snap)).toEqual([])
  })

  it("servingTickets honours lane filter", () => {
    const w = issue(1, { lane: "walkIn", displaySeq: 1 })
    const p = issue(2, { lane: "priority", displaySeq: 1 })
    const cw = applyCall(w.ticket as Waiting, {
      at: at("2026-05-08T09:05:00Z"),
      eventId: newTicketEventId(),
    })
    const cp = applyCall(p.ticket as Waiting, {
      at: at("2026-05-08T09:06:00Z"),
      eventId: newTicketEventId(),
    })
    const sw = applyStartServing(
      cw.ticket as Called,
      at("2026-05-08T09:07:00Z"),
      newTicketEventId(),
    )
    const sp = applyStartServing(
      cp.ticket as Called,
      at("2026-05-08T09:08:00Z"),
      newTicketEventId(),
    )
    const snap = replay([w.event, p.event, cw.event, cp.event, sw.event, sp.event])
    expect(servingTickets(snap, "priority").map((t) => t.id)).toEqual([p.ticket.id])
    expect(servingTickets(snap, "walkIn").map((t) => t.id)).toEqual([w.ticket.id])
  })

  it("globalPositionOf sums Waiting in upstream lanes plus position in own lane", () => {
    const p1 = issue(1, { lane: "priority", displaySeq: 1 })
    const p2 = issue(2, { lane: "priority", displaySeq: 2 })
    const w1 = issue(3, { lane: "walkIn", displaySeq: 1 })
    const w2 = issue(4, { lane: "walkIn", displaySeq: 2 })
    const r1 = issue(5, { lane: "reservation", displaySeq: 1 })
    const snap = replay([p1.event, p2.event, w1.event, w2.event, r1.event])
    expect(globalPositionOf(snap, p1.ticket.id)).toBe(0)
    expect(globalPositionOf(snap, p2.ticket.id)).toBe(1)
    expect(globalPositionOf(snap, w1.ticket.id)).toBe(2)
    expect(globalPositionOf(snap, w2.ticket.id)).toBe(3)
    expect(globalPositionOf(snap, r1.ticket.id)).toBe(4)
  })

  it("globalPositionOf returns null for a non-Waiting ticket", () => {
    const a = issue(1)
    const ca = applyCall(a.ticket as Waiting, {
      at: at("2026-05-08T09:05:00Z"),
      eventId: newTicketEventId(),
    })
    const snap = replay([a.event, ca.event])
    expect(globalPositionOf(snap, a.ticket.id)).toBeNull()
  })

  it("nextDisplaySeqInLane returns 1 for an empty lane", () => {
    expect(nextDisplaySeqInLane(empty, "priority")).toBe(1)
  })

  it("nextDisplaySeqInLane returns max displaySeq + 1 (within lane)", () => {
    const w1 = issue(1, { lane: "walkIn", displaySeq: 1 })
    const w2 = issue(2, { lane: "walkIn", displaySeq: 2 })
    const p = issue(3, { lane: "priority", displaySeq: 7 })
    const snap = replay([w1.event, w2.event, p.event])
    expect(nextDisplaySeqInLane(snap, "walkIn")).toBe(3)
    expect(nextDisplaySeqInLane(snap, "priority")).toBe(8)
    expect(nextDisplaySeqInLane(snap, "reservation")).toBe(1)
  })
})

describe("applyEvent ignores no-op transitions", () => {
  it("a Called event for a non-Waiting ticket leaves the snapshot unchanged", () => {
    const ghostId = newTicketId()
    const ghostEv = {
      id: newTicketEventId(),
      ticketId: ghostId,
      version: 1 as const,
      occurredAt: at("2026-05-08T09:00:00Z"),
      recordedAt: at("2026-05-08T09:00:00Z"),
      type: "Called" as const,
      calledBy: "staff" as const,
    }
    const result = applyEvent(empty, ghostEv)
    expect(result.tickets.size).toBe(0)
  })

  it("a Recalled event for an unknown ticket is a no-op", () => {
    const ghostEv = {
      id: newTicketEventId(),
      ticketId: newTicketId(),
      version: 1 as const,
      occurredAt: at("2026-05-08T09:00:00Z"),
      recordedAt: at("2026-05-08T09:00:00Z"),
      type: "Recalled" as const,
      recalledBy: "staff" as const,
    }
    const result = applyEvent(empty, ghostEv)
    expect(result.tickets.size).toBe(0)
  })

  it("a Recalled event for a Waiting ticket is a no-op (only Called is reversible)", () => {
    const a = issue(1)
    const recallEv = {
      id: newTicketEventId(),
      ticketId: a.ticket.id,
      version: 1 as const,
      occurredAt: at("2026-05-08T09:02:00Z"),
      recordedAt: at("2026-05-08T09:02:00Z"),
      type: "Recalled" as const,
      recalledBy: "staff" as const,
    }
    const snap = replay([a.event, recallEv])
    const t = snap.tickets.get(a.ticket.id)
    expect(t?.state).toBe("Waiting")
  })

  it("a ServingStarted event for a non-Called ticket is a no-op", () => {
    const a = issue(1)
    const ssEv = {
      id: newTicketEventId(),
      ticketId: a.ticket.id,
      version: 1 as const,
      occurredAt: at("2026-05-08T09:01:00Z"),
      recordedAt: at("2026-05-08T09:01:00Z"),
      type: "ServingStarted" as const,
      servingStartedBy: "staff" as const,
    }
    const snap = replay([a.event, ssEv])
    expect(snap.tickets.get(a.ticket.id)?.state).toBe("Waiting")
  })

  it("a ServingStarted event for an unknown ticket is a no-op", () => {
    const ghostEv = {
      id: newTicketEventId(),
      ticketId: newTicketId(),
      version: 1 as const,
      occurredAt: at("2026-05-08T09:00:00Z"),
      recordedAt: at("2026-05-08T09:00:00Z"),
      type: "ServingStarted" as const,
      servingStartedBy: "staff" as const,
    }
    expect(applyEvent(empty, ghostEv).tickets.size).toBe(0)
  })
})

describe("Recalled fold", () => {
  it("Issue → Called → Recalled returns the ticket to Waiting at the same seq", () => {
    const a = issue(1)
    const call = applyCall(a.ticket as Waiting, {
      at: at("2026-05-08T09:05:00Z"),
      eventId: newTicketEventId(),
    })
    const recall = applyRecall(
      call.ticket as Called,
      at("2026-05-08T09:06:00Z"),
      newTicketEventId(),
    )
    const snap = replay([a.event, call.event, recall.event])
    expect(currentlyServing(snap)).toBeNull()
    expect(head(snap)?.id).toBe(a.ticket.id)
    expect(head(snap)?.seq).toBe(a.ticket.seq)
  })

  it("Recalled ticket is countable as waiting again", () => {
    const a = issue(1)
    const b = issue(2)
    const callA = applyCall(a.ticket as Waiting, {
      at: at("2026-05-08T09:05:00Z"),
      eventId: newTicketEventId(),
    })
    const beforeRecall = replay([a.event, b.event, callA.event])
    expect(waitingCount(beforeRecall)).toBe(1)
    const recall = applyRecall(
      callA.ticket as Called,
      at("2026-05-08T09:06:00Z"),
      newTicketEventId(),
    )
    const afterRecall = applyMany(beforeRecall, [recall.event])
    expect(waitingCount(afterRecall)).toBe(2)
    expect(head(afterRecall)?.id).toBe(a.ticket.id)
  })
})

describe("ServingStarted fold (ADR-0063)", () => {
  it("Issue → Called → ServingStarted projects to Serving", () => {
    const a = issue(1)
    const call = applyCall(a.ticket as Waiting, {
      at: at("2026-05-08T09:05:00Z"),
      eventId: newTicketEventId(),
    })
    const start = applyStartServing(
      call.ticket as Called,
      at("2026-05-08T09:07:00Z"),
      newTicketEventId(),
    )
    const snap = replay([a.event, call.event, start.event])
    const t = snap.tickets.get(a.ticket.id)
    expect(t?.state).toBe("Serving")
  })

  it("Issue → Called → ServingStarted → MarkServed projects to Served carrying serving fields", () => {
    const a = issue(1)
    const call = applyCall(a.ticket as Waiting, {
      at: at("2026-05-08T09:05:00Z"),
      eventId: newTicketEventId(),
    })
    const start = applyStartServing(
      call.ticket as Called,
      at("2026-05-08T09:07:00Z"),
      newTicketEventId(),
    )
    const served = applyMarkServed(
      start.ticket as Serving,
      at("2026-05-08T09:10:00Z"),
      newTicketEventId(),
    )
    const snap = replay([a.event, call.event, start.event, served.event])
    const t = snap.tickets.get(a.ticket.id)
    expect(t?.state).toBe("Served")
    if (t?.state === "Served") {
      expect(t.servingStartedBy).toBe("staff")
    }
  })
})

describe("Cancelled fold (projection coverage)", () => {
  it("Issue → Cancelled removes the ticket from the waiting count", () => {
    const a = issue(1)
    const cancel = applyCancel(
      a.ticket as Waiting,
      at("2026-05-08T09:01:00Z"),
      newTicketEventId(),
      "customer",
      "changed plans",
    )
    const snap = replay([a.event, cancel.event])
    expect(waitingCount(snap)).toBe(0)
    expect(snap.tickets.get(a.ticket.id)?.state).toBe("Cancelled")
  })

  it("a second Cancelled event for an already-Cancelled ticket is a no-op", () => {
    const a = issue(1)
    const cancel = applyCancel(
      a.ticket as Waiting,
      at("2026-05-08T09:01:00Z"),
      newTicketEventId(),
      "customer",
      "x",
    )
    const snap = replay([a.event, cancel.event, cancel.event])
    expect(snap.tickets.size).toBe(1)
    expect(snap.tickets.get(a.ticket.id)?.state).toBe("Cancelled")
  })

  it("a Cancelled event for an unknown ticket is a no-op", () => {
    const ghostEv = {
      id: newTicketEventId(),
      ticketId: newTicketId(),
      version: 1 as const,
      occurredAt: at("2026-05-08T09:00:00Z"),
      recordedAt: at("2026-05-08T09:00:00Z"),
      type: "Cancelled" as const,
      cancelledBy: "customer" as const,
      reason: "x",
    }
    expect(applyEvent(empty, ghostEv).tickets.size).toBe(0)
  })

  it("a Served event for a non-Called/Serving ticket is a no-op", () => {
    const a = issue(1)
    const servedEv = {
      id: newTicketEventId(),
      ticketId: a.ticket.id,
      version: 1 as const,
      occurredAt: at("2026-05-08T09:01:00Z"),
      recordedAt: at("2026-05-08T09:01:00Z"),
      type: "Served" as const,
      servedBy: "staff" as const,
    }
    const snap = replay([a.event, servedEv])
    expect(snap.tickets.get(a.ticket.id)?.state).toBe("Waiting")
  })

  it("a NoShowed event for a non-Called ticket is a no-op", () => {
    const a = issue(1)
    const nsEv = {
      id: newTicketEventId(),
      ticketId: a.ticket.id,
      version: 1 as const,
      occurredAt: at("2026-05-08T09:01:00Z"),
      recordedAt: at("2026-05-08T09:01:00Z"),
      type: "NoShowed" as const,
      markedBy: "staff" as const,
    }
    const snap = replay([a.event, nsEv])
    expect(snap.tickets.get(a.ticket.id)?.state).toBe("Waiting")
  })

  it("a Served event for an unknown ticket is a no-op", () => {
    const ghostEv = {
      id: newTicketEventId(),
      ticketId: newTicketId(),
      version: 1 as const,
      occurredAt: at("2026-05-08T09:00:00Z"),
      recordedAt: at("2026-05-08T09:00:00Z"),
      type: "Served" as const,
      servedBy: "staff" as const,
    }
    expect(applyEvent(empty, ghostEv).tickets.size).toBe(0)
  })

  it("a NoShowed event for an unknown ticket is a no-op", () => {
    const ghostEv = {
      id: newTicketEventId(),
      ticketId: newTicketId(),
      version: 1 as const,
      occurredAt: at("2026-05-08T09:00:00Z"),
      recordedAt: at("2026-05-08T09:00:00Z"),
      type: "NoShowed" as const,
      markedBy: "staff" as const,
    }
    expect(applyEvent(empty, ghostEv).tickets.size).toBe(0)
  })

  it("Issue → Called → MarkNoShow projects to NoShow", () => {
    const a = issue(1)
    const call = applyCall(a.ticket as Waiting, {
      at: at("2026-05-08T09:05:00Z"),
      eventId: newTicketEventId(),
    })
    const ns = applyMarkNoShow(
      call.ticket as Called,
      at("2026-05-08T09:10:00Z"),
      newTicketEventId(),
      "system",
    )
    const snap = replay([a.event, call.event, ns.event])
    expect(snap.tickets.get(a.ticket.id)?.state).toBe("NoShow")
  })
})

describe("CheckedIn fold (ADR-0068)", () => {
  it("Issue → CheckedIn projects checkedInAt onto the Waiting ticket", () => {
    const a = issue(1)
    const ci = applyCheckIn(a.ticket as Waiting, at("2026-05-08T09:55:00Z"), newTicketEventId())
    const snap = replay([a.event, ci.event])
    const t = snap.tickets.get(a.ticket.id)
    expect(t?.state).toBe("Waiting")
    expect(t?.checkedInAt?.toString()).toBe(at("2026-05-08T09:55:00Z").toString())
  })

  it("re-applying CheckedIn keeps the earliest arrival (idempotent)", () => {
    const a = issue(1)
    const ci1 = applyCheckIn(a.ticket as Waiting, at("2026-05-08T09:55:00Z"), newTicketEventId())
    const snap1 = replay([a.event, ci1.event])
    const ci2 = applyCheckIn(
      snap1.tickets.get(a.ticket.id) as Waiting,
      at("2026-05-08T09:58:00Z"),
      newTicketEventId(),
    )
    const snap2 = applyEvent(snap1, ci2.event)
    expect(snap2.tickets.get(a.ticket.id)?.checkedInAt?.toString()).toBe(
      at("2026-05-08T09:55:00Z").toString(),
    )
  })

  it("a CheckedIn event for an unknown ticket is a no-op", () => {
    const ghostEv = {
      id: newTicketEventId(),
      ticketId: newTicketId(),
      version: 1 as const,
      occurredAt: at("2026-05-08T09:00:00Z"),
      recordedAt: at("2026-05-08T09:00:00Z"),
      type: "CheckedIn" as const,
      checkedInBy: "customer" as const,
    }
    expect(applyEvent(empty, ghostEv).tickets.size).toBe(0)
  })

  it("a CheckedIn event for a non-Waiting ticket is a no-op", () => {
    const a = issue(1)
    const call = applyCall(a.ticket as Waiting, {
      at: at("2026-05-08T09:05:00Z"),
      eventId: newTicketEventId(),
    })
    const ci = applyCheckIn(a.ticket as Waiting, at("2026-05-08T09:55:00Z"), newTicketEventId())
    const snap = replay([a.event, call.event, ci.event])
    const t = snap.tickets.get(a.ticket.id)
    expect(t?.state).toBe("Called")
    if (t?.state === "Called") expect(t.checkedInAt).toBeNull()
  })
})

describe("ADR-0066 / ADR-0067 — slot-aware projection", () => {
  const now = at("2026-05-08T13:55:00Z")
  const tz = Schema.decodeUnknownSync(BusinessTimeZoneSchema)("UTC")

  const reserve = (
    seq: number,
    appointmentAt: Temporal.Instant | null,
    opts?: { displaySeq?: number; idHint?: TicketId },
  ) => {
    const id = opts?.idHint ?? newTicketId()
    return applyIssue({
      id,
      seq,
      lane: "reservation",
      displaySeq: opts?.displaySeq ?? seq,
      nameKana: kana,
      phoneLast4: phone,
      freeText: free,
      appointmentAt,
      at: at("2026-05-08T09:00:00Z"),
      eventId: newTicketEventId(),
    })
  }

  it("reservationsByDeadline sorts by appointmentAt asc; null-apptAt tickets are dropped (ADR-0066 invariant)", () => {
    const a = reserve(1, at("2026-05-08T15:00:00Z"))
    const b = reserve(2, at("2026-05-08T14:00:00Z"))
    const c = reserve(3, null) // invariant violation; defensively dropped
    const snap = replay([a.event, b.event, c.event])
    const ordered = reservationsByDeadline(snap)
    expect(ordered.map((t) => t.id)).toEqual([b.ticket.id, a.ticket.id])
  })

  it("reservationsByDeadline ignores non-Waiting reservation tickets", () => {
    const a = reserve(1, at("2026-05-08T14:00:00Z"))
    const call = applyCall(a.ticket as Waiting, {
      at: at("2026-05-08T13:55:00Z"),
      eventId: newTicketEventId(),
    })
    const snap = replay([a.event, call.event])
    expect(reservationsByDeadline(snap)).toHaveLength(0)
  })

  it("firstLaneWithCallable falls through to firstLaneWithWaiting when no reservation present", () => {
    const w = issue(1) // walkIn
    const snap = replay([w.event])
    expect(firstLaneWithCallable(snap, now, Temporal.Duration.from({ minutes: 5 }))).toBe("walkIn")
  })

  it("slotOccupancy counts Waiting + Called + Serving reservations sharing the bucket startAt", () => {
    const slot = {
      date: Temporal.PlainDate.from("2026-05-08"),
      bucketId: (14 * 2) as never, // 14:00 in 30-min granularity (UTC)
      granularity: 30 as const,
      capacity: 2,
    }
    const slotStart = at("2026-05-08T14:00:00Z")
    const otherStart = at("2026-05-08T14:30:00Z")
    const a = reserve(1, slotStart)
    const b = reserve(2, slotStart)
    const c = reserve(3, otherStart) // different bucket
    const snap = replay([a.event, b.event, c.event])
    expect(slotOccupancy(snap, slot, tz)).toBe(2)
  })

  it("slotOccupancy ignores Cancelled / NoShow / Served reservations", () => {
    const slot = {
      date: Temporal.PlainDate.from("2026-05-08"),
      bucketId: (14 * 2) as never,
      granularity: 30 as const,
      capacity: 2,
    }
    const slotStart = at("2026-05-08T14:00:00Z")
    const a = reserve(1, slotStart)
    const cancel = applyCancel(
      a.ticket as Waiting,
      at("2026-05-08T13:30:00Z"),
      newTicketEventId(),
      "customer",
      "changed plans",
    )
    const snap = replay([a.event, cancel.event])
    expect(slotOccupancy(snap, slot, tz)).toBe(0)
  })

  it("slotOccupancy ignores reservation lane tickets with null appointmentAt (invariant violation)", () => {
    const slot = {
      date: Temporal.PlainDate.from("2026-05-08"),
      bucketId: (14 * 2) as never,
      granularity: 30 as const,
      capacity: 2,
    }
    const a = reserve(1, null)
    const snap = replay([a.event])
    expect(slotOccupancy(snap, slot, tz)).toBe(0)
  })

  it("slotOccupancy ignores walk-in / priority lane tickets even with appointmentAt", () => {
    const slot = {
      date: Temporal.PlainDate.from("2026-05-08"),
      bucketId: (14 * 2) as never,
      granularity: 30 as const,
      capacity: 2,
    }
    const slotStart = at("2026-05-08T14:00:00Z")
    const w = applyIssue({
      id: newTicketId(),
      seq: 1,
      lane: "walkIn",
      displaySeq: 1,
      nameKana: kana,
      phoneLast4: phone,
      freeText: free,
      appointmentAt: slotStart,
      at: at("2026-05-08T09:00:00Z"),
      eventId: newTicketEventId(),
    })
    const snap = replay([w.event])
    expect(slotOccupancy(snap, slot, tz)).toBe(0)
  })
})

describe("ADR-0070 occupancyExcludingSelf (capacity guard helper)", () => {
  // The fixture uses UTC so the bucket math lines up with the
  // explicit `2026-05-08T14:00:00Z` appointmentAt: 14:00 UTC at
  // 30-min granularity = bucketId 28. (Asia/Tokyo would shift the
  // bucket by +9h → 46, missing the slot.)
  const tz2 = Schema.decodeUnknownSync(BusinessTimeZoneSchema)("UTC")
  const slot = {
    date: Temporal.PlainDate.from("2026-05-08"),
    bucketId: (14 * 2) as never,
    granularity: 30 as const,
    capacity: 2,
  }
  const slotStart = at("2026-05-08T14:00:00Z")
  const reservation = (idHint: TicketId) =>
    applyIssue({
      id: idHint,
      seq: 1,
      lane: "reservation",
      displaySeq: 1,
      nameKana: kana,
      phoneLast4: phone,
      freeText: free,
      appointmentAt: slotStart,
      at: at("2026-05-08T09:00:00Z"),
      eventId: newTicketEventId(),
    })

  it("excludes the named ticket from the count", () => {
    const selfId = newTicketId()
    const otherId = newTicketId()
    const self = reservation(selfId)
    const other = reservation(otherId)
    const snap = replay([self.event, other.event])
    expect(occupancyExcludingSelf(snap, selfId, slot, tz2)).toBe(1)
    expect(occupancyExcludingSelf(snap, otherId, slot, tz2)).toBe(1)
    expect(occupancyExcludingSelf(snap, newTicketId(), slot, tz2)).toBe(2)
  })

  it("does not count walk-in lane tickets even at the same instant", () => {
    const selfId = newTicketId()
    const walkInId = newTicketId()
    const self = reservation(selfId)
    const walkIn = applyIssue({
      id: walkInId,
      seq: 2,
      lane: "walkIn",
      displaySeq: 1,
      nameKana: kana,
      phoneLast4: phone,
      freeText: free,
      appointmentAt: slotStart,
      at: at("2026-05-08T09:00:00Z"),
      eventId: newTicketEventId(),
    })
    const snap = replay([self.event, walkIn.event])
    expect(occupancyExcludingSelf(snap, selfId, slot, tz2)).toBe(0)
  })

  it("does not count reservation tickets with null appointmentAt", () => {
    const selfId = newTicketId()
    const malformedId = newTicketId()
    const self = reservation(selfId)
    // Lane invariant violation — would never happen via the public
    // boundary, but the helper has to be defensive against an
    // un-tagged null lookup result.
    const malformed = applyIssue({
      id: malformedId,
      seq: 3,
      lane: "reservation",
      displaySeq: 1,
      nameKana: kana,
      phoneLast4: phone,
      freeText: free,
      appointmentAt: null,
      at: at("2026-05-08T09:00:00Z"),
      eventId: newTicketEventId(),
    })
    const snap = replay([self.event, malformed.event])
    expect(occupancyExcludingSelf(snap, selfId, slot, tz2)).toBe(0)
  })

  it("does not count terminal-state tickets at the same instant", () => {
    const selfId = newTicketId()
    const otherId = newTicketId()
    const self = reservation(selfId)
    const other = reservation(otherId)
    const otherCancel = applyCancel(
      other.ticket as Waiting,
      at("2026-05-08T10:00:00Z"),
      newTicketEventId(),
      "customer",
      "test",
    )
    const snap = replay([self.event, other.event, otherCancel.event])
    expect(occupancyExcludingSelf(snap, selfId, slot, tz2)).toBe(0)
  })

  it("does not count reservation tickets booked at a different instant", () => {
    const selfId = newTicketId()
    const otherId = newTicketId()
    const self = reservation(selfId)
    // Same lane / state / appointment-bearing — but at a different
    // slot instant. The final Temporal.Instant.compare branch in
    // occupancyExcludingSelf rejects this row.
    const other = applyIssue({
      id: otherId,
      seq: 4,
      lane: "reservation",
      displaySeq: 2,
      nameKana: kana,
      phoneLast4: phone,
      freeText: free,
      appointmentAt: at("2026-05-08T15:00:00Z"),
      at: at("2026-05-08T09:00:00Z"),
      eventId: newTicketEventId(),
    })
    const snap = replay([self.event, other.event])
    expect(occupancyExcludingSelf(snap, selfId, slot, tz2)).toBe(0)
  })
})

describe("ADR-0070 Rescheduled fold (projection coverage)", () => {
  const reserveAt = (appointmentAt: Temporal.Instant, opts?: { idHint?: TicketId; lane?: Lane }) =>
    applyIssue({
      id: opts?.idHint ?? newTicketId(),
      seq: 1,
      lane: opts?.lane ?? "reservation",
      displaySeq: 1,
      nameKana: kana,
      phoneLast4: phone,
      freeText: free,
      appointmentAt,
      at: at("2026-05-08T09:00:00Z"),
      eventId: newTicketEventId(),
    })

  it("Rescheduled event updates appointmentAt on the Waiting ticket", () => {
    const apptA = at("2026-05-08T14:00:00Z")
    const apptB = at("2026-05-08T15:00:00Z")
    const issued = reserveAt(apptA)
    const reschedule = {
      id: newTicketEventId(),
      ticketId: issued.ticket.id,
      version: 1 as const,
      occurredAt: at("2026-05-08T13:00:00Z"),
      recordedAt: at("2026-05-08T13:00:00Z"),
      type: "Rescheduled" as const,
      fromAppointmentAt: apptA,
      toAppointmentAt: apptB,
      rescheduledBy: "customer" as const,
    }
    const snap = replay([issued.event, reschedule])
    const after = snap.tickets.get(issued.ticket.id)
    expect(after?.appointmentAt).not.toBeNull()
    if (after?.appointmentAt !== null && after?.appointmentAt !== undefined) {
      expect(Temporal.Instant.compare(after.appointmentAt, apptB)).toBe(0)
    }
  })

  it("Rescheduled event is a no-op when the ticket is not in the active set", () => {
    const apptA = at("2026-05-08T14:00:00Z")
    const apptB = at("2026-05-08T15:00:00Z")
    const issued = reserveAt(apptA)
    const cancelled = applyCancel(
      issued.ticket as Waiting,
      at("2026-05-08T10:00:00Z"),
      newTicketEventId(),
      "customer",
      "test",
    )
    const reschedule = {
      id: newTicketEventId(),
      ticketId: issued.ticket.id,
      version: 1 as const,
      occurredAt: at("2026-05-08T11:00:00Z"),
      recordedAt: at("2026-05-08T11:00:00Z"),
      type: "Rescheduled" as const,
      fromAppointmentAt: apptA,
      toAppointmentAt: apptB,
      rescheduledBy: "customer" as const,
    }
    const snap = replay([issued.event, cancelled.event, reschedule])
    const after = snap.tickets.get(issued.ticket.id)
    expect(after?.state).toBe("Cancelled")
  })

  it("Rescheduled event is a no-op when ticketId is unknown", () => {
    const reschedule = {
      id: newTicketEventId(),
      ticketId: newTicketId(),
      version: 1 as const,
      occurredAt: at("2026-05-08T11:00:00Z"),
      recordedAt: at("2026-05-08T11:00:00Z"),
      type: "Rescheduled" as const,
      fromAppointmentAt: at("2026-05-08T14:00:00Z"),
      toAppointmentAt: at("2026-05-08T15:00:00Z"),
      rescheduledBy: "customer" as const,
    }
    const snap = replay([reschedule])
    expect(snap.tickets.size).toBe(0)
  })

  it("Rescheduled event is a no-op on a walk-in lane ticket", () => {
    const apptA = at("2026-05-08T14:00:00Z")
    const apptB = at("2026-05-08T15:00:00Z")
    // Walk-in ticket with a misset appointmentAt — this should never
    // happen via the public boundary, but the projection should still
    // refuse to mutate.
    const issued = reserveAt(apptA, { lane: "walkIn" })
    const reschedule = {
      id: newTicketEventId(),
      ticketId: issued.ticket.id,
      version: 1 as const,
      occurredAt: at("2026-05-08T11:00:00Z"),
      recordedAt: at("2026-05-08T11:00:00Z"),
      type: "Rescheduled" as const,
      fromAppointmentAt: apptA,
      toAppointmentAt: apptB,
      rescheduledBy: "customer" as const,
    }
    const snap = replay([issued.event, reschedule])
    const after = snap.tickets.get(issued.ticket.id)
    expect(after?.appointmentAt).not.toBeNull()
    if (after?.appointmentAt !== null && after?.appointmentAt !== undefined) {
      expect(Temporal.Instant.compare(after.appointmentAt, apptA)).toBe(0)
    }
  })
})
