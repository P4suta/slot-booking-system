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
  firstLaneWithWaiting,
  globalPositionOf,
  head,
  headOfLane,
  nextDisplaySeqInLane,
  positionOf,
  replay,
  servingTickets,
  waitingCount,
  waitingTickets,
} from "../../../src/domain/queue/projection.js"
import type { Called, Serving, Waiting } from "../../../src/domain/queue/Ticket.js"
import {
  applyCall,
  applyCancel,
  applyIssue,
  applyMarkNoShow,
  applyMarkServed,
  applyRecall,
  applyReorder,
  applyStartServing,
} from "../../../src/domain/queue/transitions.js"
import { newTicketEventId, newTicketId, type TicketId } from "../../../src/domain/types/EntityId.js"
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

  it("Reorder skips peers in other lanes when computing the rebalance set", () => {
    // rebalanceLane's lane filter: peers in different lanes (here
    // priority) must NOT participate in the walkIn rebalance even
    // though they share the snapshot.
    const w1 = issue(1, { lane: "walkIn", displaySeq: 1 })
    const w2 = issue(2, { lane: "walkIn", displaySeq: 2 })
    const p1 = issue(3, { lane: "priority", displaySeq: 5 })
    const reorder = applyReorder(w2.ticket as Waiting, {
      afterTicketId: null,
      at: at("2026-05-08T09:10:00Z"),
      eventId: newTicketEventId(),
    })
    const snap = replay([w1.event, w2.event, p1.event, reorder.event])
    const walkIn = waitingTickets(snap, "walkIn").map((t) => t.id)
    expect(walkIn).toEqual([w2.ticket.id, w1.ticket.id])
    // priority lane is untouched.
    const priority = waitingTickets(snap, "priority").map((t) => t.id)
    expect(priority).toEqual([p1.ticket.id])
    expect((snap.tickets.get(p1.ticket.id) as Waiting).displaySeq).toBe(5)
  })

  it("Reorder event with afterTicketId === null preserves displaySeq when target is already lane-head", () => {
    // rebalanceLane's `if (peer.displaySeq !== nextDisplaySeq)` else
    // branch: when the rebuilt order already matches the existing
    // displaySeq, the snapshot map gets a no-op set (the same row).
    const a = issue(1, { lane: "walkIn", displaySeq: 1 })
    const b = issue(2, { lane: "walkIn", displaySeq: 2 })
    const reorder = applyReorder(a.ticket as Waiting, {
      afterTicketId: null,
      at: at("2026-05-08T09:10:00Z"),
      eventId: newTicketEventId(),
    })
    const snap = replay([a.event, b.event, reorder.event])
    const got = waitingTickets(snap, "walkIn")
    expect(got.map((t) => t.id)).toEqual([a.ticket.id, b.ticket.id])
    expect(got[0]?.displaySeq).toBe(1)
    expect(got[1]?.displaySeq).toBe(2)
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

describe("Reorder rebalances lane-internal displaySeq", () => {
  it("Reorder(target, null) makes target the lane head with displaySeq 1, others shift", () => {
    const a = issue(1, { lane: "walkIn", displaySeq: 1 })
    const b = issue(2, { lane: "walkIn", displaySeq: 2 })
    const c = issue(3, { lane: "walkIn", displaySeq: 3 })
    const reorder = applyReorder(c.ticket as Waiting, {
      afterTicketId: null,
      at: at("2026-05-08T09:10:00Z"),
      eventId: newTicketEventId(),
    })
    const snap = replay([a.event, b.event, c.event, reorder.event])
    const order = waitingTickets(snap, "walkIn").map((t) => t.id)
    expect(order).toEqual([c.ticket.id, a.ticket.id, b.ticket.id])
    const moved = snap.tickets.get(c.ticket.id) as Waiting
    expect(moved.displaySeq).toBe(1)
  })

  it("Reorder(target, after) inserts target right after the named peer", () => {
    const a = issue(1, { lane: "walkIn", displaySeq: 1 })
    const b = issue(2, { lane: "walkIn", displaySeq: 2 })
    const c = issue(3, { lane: "walkIn", displaySeq: 3 })
    const reorder = applyReorder(c.ticket as Waiting, {
      afterTicketId: a.ticket.id,
      at: at("2026-05-08T09:10:00Z"),
      eventId: newTicketEventId(),
    })
    const snap = replay([a.event, b.event, c.event, reorder.event])
    const order = waitingTickets(snap, "walkIn").map((t) => t.id)
    expect(order).toEqual([a.ticket.id, c.ticket.id, b.ticket.id])
  })

  it("Reorder preserves the ticket's seq even when displaySeq changes", () => {
    const a = issue(1, { lane: "walkIn", displaySeq: 1 })
    const b = issue(2, { lane: "walkIn", displaySeq: 2 })
    const reorder = applyReorder(b.ticket as Waiting, {
      afterTicketId: null,
      at: at("2026-05-08T09:10:00Z"),
      eventId: newTicketEventId(),
    })
    const snap = replay([a.event, b.event, reorder.event])
    const moved = snap.tickets.get(b.ticket.id) as Waiting
    expect(moved.seq).toBe(b.ticket.seq)
    expect(moved.displaySeq).toBe(1)
  })

  it("Reorder with unknown afterTicketId is a no-op", () => {
    const a = issue(1, { lane: "walkIn", displaySeq: 1 })
    const b = issue(2, { lane: "walkIn", displaySeq: 2 })
    const reorder = applyReorder(b.ticket as Waiting, {
      afterTicketId: newTicketId(),
      at: at("2026-05-08T09:10:00Z"),
      eventId: newTicketEventId(),
    })
    const snap = replay([a.event, b.event, reorder.event])
    const order = waitingTickets(snap, "walkIn").map((t) => t.id)
    expect(order).toEqual([a.ticket.id, b.ticket.id])
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

  it("a Reordered event for a non-Waiting ticket is a no-op", () => {
    const a = issue(1)
    const ca = applyCall(a.ticket as Waiting, {
      at: at("2026-05-08T09:05:00Z"),
      eventId: newTicketEventId(),
    })
    const reorderEv = {
      id: newTicketEventId(),
      ticketId: a.ticket.id,
      version: 1 as const,
      occurredAt: at("2026-05-08T09:06:00Z"),
      recordedAt: at("2026-05-08T09:06:00Z"),
      type: "Reordered" as const,
      afterTicketId: null,
      reorderedBy: "staff" as const,
    }
    const snap = replay([a.event, ca.event, reorderEv])
    expect(snap.tickets.get(a.ticket.id)?.state).toBe("Called")
  })

  it("a Reordered event for an unknown ticket is a no-op", () => {
    const ghostEv = {
      id: newTicketEventId(),
      ticketId: newTicketId(),
      version: 1 as const,
      occurredAt: at("2026-05-08T09:00:00Z"),
      recordedAt: at("2026-05-08T09:00:00Z"),
      type: "Reordered" as const,
      afterTicketId: null,
      reorderedBy: "staff" as const,
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
