import { Temporal } from "@js-temporal/polyfill"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  applyEvent,
  applyMany,
  empty,
  head,
  positionOf,
  replay,
  serving,
  waitingCount,
} from "../../../src/domain/queue/projection.js"
import type { Called, Waiting } from "../../../src/domain/queue/Ticket.js"
import {
  applyCallNext,
  applyCancel,
  applyIssue,
  applyMarkNoShow,
  applyMarkServed,
  applyRecall,
} from "../../../src/domain/queue/transitions.js"
import { newTicketEventId, newTicketId, type TicketId } from "../../../src/domain/types/EntityId.js"
import { FreeTextSchema } from "../../../src/domain/value-objects/FreeText.js"
import { NameKanaSchema } from "../../../src/domain/value-objects/NameKana.js"
import { PhoneLast4Schema } from "../../../src/domain/value-objects/PhoneLast4.js"

const at = (iso: string) => Temporal.Instant.from(iso)
const kana = Schema.decodeUnknownSync(NameKanaSchema)("ヤマダ タロウ")
const phone = Schema.decodeUnknownSync(PhoneLast4Schema)("1234")
const free = Schema.decodeUnknownSync(FreeTextSchema)("用件")

const issue = (seq: number, idHint?: TicketId) => {
  const id = idHint ?? newTicketId()
  return applyIssue({
    id,
    seq,
    nameKana: kana,
    phoneLast4: phone,
    freeText: free,
    at: at(`2026-05-08T09:0${seq}:00Z`),
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

describe("derived queries — head / serving / positionOf / waitingCount", () => {
  it("head returns the lowest-seq Waiting ticket", () => {
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

  it("serving returns the lowest-seq Called ticket", () => {
    const a = issue(1)
    const callA = applyCallNext(a.ticket as Waiting, at("2026-05-08T09:05:00Z"), newTicketEventId())
    const snap = replay([a.event, callA.event])
    expect(serving(snap)?.id).toBe(a.ticket.id)
  })

  it("serving returns null after the Called ticket transitions to Served", () => {
    const a = issue(1)
    const callA = applyCallNext(a.ticket as Waiting, at("2026-05-08T09:05:00Z"), newTicketEventId())
    const served = applyMarkServed(
      callA.ticket as Called,
      at("2026-05-08T09:10:00Z"),
      newTicketEventId(),
    )
    const snap = replay([a.event, callA.event, served.event])
    expect(serving(snap)).toBeNull()
  })

  it("positionOf reports the number of waiting tickets ahead", () => {
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
    const callA = applyCallNext(a.ticket as Waiting, at("2026-05-08T09:05:00Z"), newTicketEventId())
    const snap = replay([a.event, callA.event])
    expect(positionOf(snap, a.ticket.id)).toBeNull()
  })

  it("positionOf returns null for an unknown ticket", () => {
    expect(positionOf(empty, newTicketId())).toBeNull()
  })

  it("head skips non-Waiting tickets in a mixed-state snapshot", () => {
    const a = issue(1)
    const b = issue(2)
    const callA = applyCallNext(a.ticket as Waiting, at("2026-05-08T09:05:00Z"), newTicketEventId())
    const snap = replay([a.event, b.event, callA.event])
    expect(head(snap)?.id).toBe(b.ticket.id)
  })

  it("serving skips non-Called tickets in a mixed-state snapshot", () => {
    const a = issue(1)
    const b = issue(2)
    const callA = applyCallNext(a.ticket as Waiting, at("2026-05-08T09:05:00Z"), newTicketEventId())
    const snap = replay([a.event, b.event, callA.event])
    expect(serving(snap)?.id).toBe(a.ticket.id)
  })

  it("positionOf skips non-Waiting tickets when counting ahead", () => {
    const a = issue(1)
    const b = issue(2)
    const c = issue(3)
    const callA = applyCallNext(a.ticket as Waiting, at("2026-05-08T09:05:00Z"), newTicketEventId())
    // a is now Called; among Waiting [b, c], b is the head.
    const snap = replay([a.event, b.event, c.event, callA.event])
    expect(positionOf(snap, b.ticket.id)).toBe(0)
    expect(positionOf(snap, c.ticket.id)).toBe(1)
  })

  it("serving picks the lowest-seq Called ticket in a multi-Called snapshot", () => {
    // The single-writer DO never produces two simultaneous Called
    // tickets, but the projection must remain total under any event
    // sequence. Synthesise two tickets and call both, then verify
    // the lower-seq one wins.
    const a = issue(1)
    const b = issue(2)
    const callA = applyCallNext(a.ticket as Waiting, at("2026-05-08T09:05:00Z"), newTicketEventId())
    const callB = applyCallNext(b.ticket as Waiting, at("2026-05-08T09:06:00Z"), newTicketEventId())
    const snap = replay([a.event, b.event, callA.event, callB.event])
    expect(serving(snap)?.id).toBe(a.ticket.id)
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
})

describe("Recalled fold", () => {
  it("Issue → Called → Recalled returns the ticket to Waiting at the same seq", () => {
    const a = issue(1)
    const call = applyCallNext(a.ticket as Waiting, at("2026-05-08T09:05:00Z"), newTicketEventId())
    const recall = applyRecall(
      call.ticket as Called,
      at("2026-05-08T09:06:00Z"),
      newTicketEventId(),
    )
    const snap = replay([a.event, call.event, recall.event])
    expect(serving(snap)).toBeNull()
    expect(head(snap)?.id).toBe(a.ticket.id)
    expect(head(snap)?.seq).toBe(a.ticket.seq)
  })

  it("Recalled ticket is countable as waiting again", () => {
    const a = issue(1)
    const b = issue(2)
    const callA = applyCallNext(a.ticket as Waiting, at("2026-05-08T09:05:00Z"), newTicketEventId())
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

  it("a Served event for a non-Called ticket is a no-op", () => {
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
    const call = applyCallNext(a.ticket as Waiting, at("2026-05-08T09:05:00Z"), newTicketEventId())
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
