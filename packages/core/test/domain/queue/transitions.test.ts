import { Temporal } from "@js-temporal/polyfill"
import { Result, Schema } from "effect"
import { describe, expect, it } from "vitest"
import type { Called, Waiting } from "../../../src/domain/queue/Ticket.js"
import {
  applyCallNext,
  applyCancel,
  applyIssue,
  applyMarkNoShow,
  applyMarkServed,
  guardActive,
  invalidTransition,
} from "../../../src/domain/queue/transitions.js"
import { newTicketEventId, newTicketId } from "../../../src/domain/types/EntityId.js"
import { FreeTextSchema } from "../../../src/domain/value-objects/FreeText.js"
import { NameKanaSchema } from "../../../src/domain/value-objects/NameKana.js"
import { PhoneLast4Schema } from "../../../src/domain/value-objects/PhoneLast4.js"

const at = (iso: string) => Temporal.Instant.from(iso)
const kana = Schema.decodeUnknownSync(NameKanaSchema)("ヤマダ タロウ")
const phone = Schema.decodeUnknownSync(PhoneLast4Schema)("1234")
const free = Schema.decodeUnknownSync(FreeTextSchema)("用件メモ")

const issued = (): Result.Result<Waiting, never> => {
  const r = applyIssue({
    id: newTicketId(),
    seq: 1,
    nameKana: kana,
    phoneLast4: phone,
    freeText: free,
    at: at("2026-05-08T09:00:00Z"),
    eventId: newTicketEventId(),
  })
  if (Result.isFailure(r)) throw new Error("issue failed")
  return Result.succeed(r.success.ticket as Waiting)
}

const succ = <A, E>(r: Result.Result<A, E>): A => {
  if (Result.isFailure(r)) throw new Error(`expected success, got ${String(r.failure)}`)
  return r.success
}

describe("applyIssue", () => {
  it("returns a Waiting ticket plus an Issued event in lockstep", () => {
    const r = succ(issued())
    expect(r.state).toBe("Waiting")
    expect(r.seq).toBe(1)
  })

  it("the issued event mirrors the ticket fields", () => {
    const id = newTicketId()
    const r = applyIssue({
      id,
      seq: 5,
      nameKana: kana,
      phoneLast4: phone,
      freeText: null,
      at: at("2026-05-08T09:00:00Z"),
      eventId: newTicketEventId(),
    })
    const { ticket, event } = succ(r)
    expect(ticket.id).toBe(id)
    expect(event.type).toBe("Issued")
    if (event.type === "Issued") {
      expect(event.seq).toBe(5)
      expect(event.freeText).toBeNull()
    }
  })
})

describe("applyCallNext", () => {
  it("transitions Waiting → Called", () => {
    const w = succ(issued())
    const r = applyCallNext(w, at("2026-05-08T09:05:00Z"), newTicketEventId())
    const { ticket, event } = succ(r)
    expect(ticket.state).toBe("Called")
    expect(event.type).toBe("Called")
  })

  it("defaults calledBy to staff", () => {
    const w = succ(issued())
    const r = applyCallNext(w, at("2026-05-08T09:05:00Z"), newTicketEventId())
    const { ticket } = succ(r)
    if (ticket.state === "Called") expect(ticket.calledBy).toBe("staff")
  })
})

describe("applyMarkServed / applyMarkNoShow / applyCancel", () => {
  const called = (): Called => {
    const w = succ(issued())
    const r = applyCallNext(w, at("2026-05-08T09:05:00Z"), newTicketEventId())
    return succ(r).ticket as Called
  }

  it("applyMarkServed transitions Called → Served", () => {
    const r = applyMarkServed(called(), at("2026-05-08T09:10:00Z"), newTicketEventId())
    const { ticket } = succ(r)
    expect(ticket.state).toBe("Served")
  })

  it("applyMarkNoShow transitions Called → NoShow with the system actor", () => {
    const r = applyMarkNoShow(called(), at("2026-05-08T09:10:00Z"), newTicketEventId(), "system")
    const { ticket } = succ(r)
    expect(ticket.state).toBe("NoShow")
    if (ticket.state === "NoShow") expect(ticket.markedBy).toBe("system")
  })

  it("applyCancel from Waiting records the customer reason", () => {
    const r = applyCancel(
      succ(issued()),
      at("2026-05-08T09:01:00Z"),
      newTicketEventId(),
      "customer",
      "changed plans",
    )
    const { ticket } = succ(r)
    expect(ticket.state).toBe("Cancelled")
    if (ticket.state === "Cancelled") expect(ticket.reason).toBe("changed plans")
  })

  it("applyCancel from Called marks staff cancellation", () => {
    const r = applyCancel(
      called(),
      at("2026-05-08T09:06:00Z"),
      newTicketEventId(),
      "staff",
      "shop closing",
    )
    expect(succ(r).ticket.state).toBe("Cancelled")
  })
})

describe("guardActive", () => {
  it("returns null for Waiting", () => {
    expect(guardActive(succ(issued()))).toBeNull()
  })

  it("returns AlreadyCancelled for a Cancelled ticket", () => {
    const cancelled = succ(
      applyCancel(succ(issued()), at("2026-05-08T09:01:00Z"), newTicketEventId(), "customer", "x"),
    ).ticket
    const err = guardActive(cancelled)
    expect(err?._tag).toBe("AlreadyCancelled")
  })

  it("returns AlreadyCompleted for a Served ticket", () => {
    const w = succ(issued())
    const c = succ(applyCallNext(w, at("2026-05-08T09:05:00Z"), newTicketEventId()))
      .ticket as Called
    const s = succ(applyMarkServed(c, at("2026-05-08T09:10:00Z"), newTicketEventId())).ticket
    expect(guardActive(s)?._tag).toBe("AlreadyCompleted")
  })

  it("returns AlreadyNoShow for a NoShow ticket", () => {
    const w = succ(issued())
    const c = succ(applyCallNext(w, at("2026-05-08T09:05:00Z"), newTicketEventId()))
      .ticket as Called
    const ns = succ(applyMarkNoShow(c, at("2026-05-08T09:10:00Z"), newTicketEventId())).ticket
    expect(guardActive(ns)?._tag).toBe("AlreadyNoShow")
  })

  it("returns null for Called", () => {
    const w = succ(issued())
    const c = succ(applyCallNext(w, at("2026-05-08T09:05:00Z"), newTicketEventId()))
      .ticket as Called
    expect(guardActive(c)).toBeNull()
  })
})

describe("invalidTransition", () => {
  it("synthesises an InvalidStateTransition error with the offending row", () => {
    const err = invalidTransition("Waiting", "MarkServed")
    expect(err._tag).toBe("InvalidStateTransition")
    expect(err.from).toBe("Waiting")
    expect(err.command).toBe("MarkServed")
  })
})
