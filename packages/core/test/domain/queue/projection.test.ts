import { Temporal } from "@js-temporal/polyfill"
import { Result, Schema } from "effect"
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
import {
  applyCallNext,
  applyIssue,
  applyMarkServed,
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
  const r = applyIssue({
    id,
    seq,
    nameKana: kana,
    phoneLast4: phone,
    freeText: free,
    at: at(`2026-05-08T09:0${seq}:00Z`),
    eventId: newTicketEventId(),
  })
  if (Result.isFailure(r)) throw new Error("issue failed")
  return r.success
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
    const callA = applyCallNext(
      a.ticket as Parameters<typeof applyCallNext>[0],
      at("2026-05-08T09:05:00Z"),
      newTicketEventId(),
    )
    if (Result.isFailure(callA)) throw new Error("call failed")
    const snap = replay([a.event, callA.success.event])
    expect(serving(snap)?.id).toBe(a.ticket.id)
  })

  it("serving returns null after the Called ticket transitions to Served", () => {
    const a = issue(1)
    const callA = applyCallNext(
      a.ticket as Parameters<typeof applyCallNext>[0],
      at("2026-05-08T09:05:00Z"),
      newTicketEventId(),
    )
    if (Result.isFailure(callA)) throw new Error("call failed")
    const calledTicket = callA.success.ticket
    if (calledTicket.state !== "Called") throw new Error("expected Called")
    const servedR = applyMarkServed(calledTicket, at("2026-05-08T09:10:00Z"), newTicketEventId())
    if (Result.isFailure(servedR)) throw new Error("serve failed")
    const snap = replay([a.event, callA.success.event, servedR.success.event])
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
    const callA = applyCallNext(
      a.ticket as Parameters<typeof applyCallNext>[0],
      at("2026-05-08T09:05:00Z"),
      newTicketEventId(),
    )
    if (Result.isFailure(callA)) throw new Error("call failed")
    const snap = replay([a.event, callA.success.event])
    expect(positionOf(snap, a.ticket.id)).toBeNull()
  })

  it("positionOf returns null for an unknown ticket", () => {
    expect(positionOf(empty, newTicketId())).toBeNull()
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
})
