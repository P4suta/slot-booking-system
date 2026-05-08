import { Temporal } from "@js-temporal/polyfill"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import type { Called, Waiting } from "../../../src/domain/queue/Ticket.js"
import {
  applyCallNext,
  applyCancel,
  applyIssue,
  applyMarkNoShow,
  applyMarkServed,
  applyRecall,
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

const issued = (): Waiting => {
  const { ticket } = applyIssue({
    id: newTicketId(),
    seq: 1,
    nameKana: kana,
    phoneLast4: phone,
    freeText: free,
    at: at("2026-05-08T09:00:00Z"),
    eventId: newTicketEventId(),
  })
  return ticket as Waiting
}

describe("applyIssue", () => {
  it("returns a Waiting ticket plus an Issued event in lockstep", () => {
    const w = issued()
    expect(w.state).toBe("Waiting")
    expect(w.seq).toBe(1)
  })

  it("the issued event mirrors the ticket fields", () => {
    const id = newTicketId()
    const { ticket, event } = applyIssue({
      id,
      seq: 5,
      nameKana: kana,
      phoneLast4: phone,
      freeText: null,
      at: at("2026-05-08T09:00:00Z"),
      eventId: newTicketEventId(),
    })
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
    const { ticket, event } = applyCallNext(
      issued(),
      at("2026-05-08T09:05:00Z"),
      newTicketEventId(),
    )
    expect(ticket.state).toBe("Called")
    expect(event.type).toBe("Called")
  })

  it("defaults calledBy to staff", () => {
    const { ticket } = applyCallNext(issued(), at("2026-05-08T09:05:00Z"), newTicketEventId())
    if (ticket.state === "Called") expect(ticket.calledBy).toBe("staff")
  })

  it("respects an explicit non-staff actor on both ticket and event", () => {
    const { ticket, event } = applyCallNext(
      issued(),
      at("2026-05-08T09:05:00Z"),
      newTicketEventId(),
      "system",
    )
    if (ticket.state === "Called") expect(ticket.calledBy).toBe("system")
    if (event.type === "Called") expect(event.calledBy).toBe("system")
  })
})

describe("applyMarkServed / applyMarkNoShow / applyCancel", () => {
  const called = (): Called => {
    const { ticket } = applyCallNext(issued(), at("2026-05-08T09:05:00Z"), newTicketEventId())
    return ticket as Called
  }

  it("applyMarkServed transitions Called → Served", () => {
    const { ticket } = applyMarkServed(called(), at("2026-05-08T09:10:00Z"), newTicketEventId())
    expect(ticket.state).toBe("Served")
  })

  it("applyMarkServed honours an explicit servedBy", () => {
    const { ticket, event } = applyMarkServed(
      called(),
      at("2026-05-08T09:10:00Z"),
      newTicketEventId(),
      "system",
    )
    if (ticket.state === "Served") expect(ticket.servedBy).toBe("system")
    if (event.type === "Served") expect(event.servedBy).toBe("system")
  })

  it("applyMarkNoShow transitions Called → NoShow with the system actor", () => {
    const { ticket } = applyMarkNoShow(
      called(),
      at("2026-05-08T09:10:00Z"),
      newTicketEventId(),
      "system",
    )
    expect(ticket.state).toBe("NoShow")
    if (ticket.state === "NoShow") expect(ticket.markedBy).toBe("system")
  })

  it("applyMarkNoShow defaults markedBy to staff", () => {
    const { ticket } = applyMarkNoShow(called(), at("2026-05-08T09:10:00Z"), newTicketEventId())
    if (ticket.state === "NoShow") expect(ticket.markedBy).toBe("staff")
  })

  it("applyCancel from Waiting records the customer reason", () => {
    const { ticket } = applyCancel(
      issued(),
      at("2026-05-08T09:01:00Z"),
      newTicketEventId(),
      "customer",
      "changed plans",
    )
    expect(ticket.state).toBe("Cancelled")
    if (ticket.state === "Cancelled") expect(ticket.reason).toBe("changed plans")
  })

  it("applyCancel from Called marks staff cancellation", () => {
    const { ticket, event } = applyCancel(
      called(),
      at("2026-05-08T09:06:00Z"),
      newTicketEventId(),
      "staff",
      "shop closing",
    )
    expect(ticket.state).toBe("Cancelled")
    if (event.type === "Cancelled") {
      expect(event.cancelledBy).toBe("staff")
      expect(event.reason).toBe("shop closing")
    }
  })
})

describe("guardActive", () => {
  it("returns null for Waiting", () => {
    expect(guardActive(issued())).toBeNull()
  })

  it("returns AlreadyCancelled for a Cancelled ticket", () => {
    const { ticket } = applyCancel(
      issued(),
      at("2026-05-08T09:01:00Z"),
      newTicketEventId(),
      "customer",
      "x",
    )
    expect(guardActive(ticket)?._tag).toBe("AlreadyCancelled")
  })

  it("returns AlreadyCompleted for a Served ticket", () => {
    const c = applyCallNext(issued(), at("2026-05-08T09:05:00Z"), newTicketEventId())
      .ticket as Called
    const { ticket } = applyMarkServed(c, at("2026-05-08T09:10:00Z"), newTicketEventId())
    expect(guardActive(ticket)?._tag).toBe("AlreadyCompleted")
  })

  it("returns AlreadyNoShow for a NoShow ticket", () => {
    const c = applyCallNext(issued(), at("2026-05-08T09:05:00Z"), newTicketEventId())
      .ticket as Called
    const { ticket } = applyMarkNoShow(c, at("2026-05-08T09:10:00Z"), newTicketEventId())
    expect(guardActive(ticket)?._tag).toBe("AlreadyNoShow")
  })

  it("returns null for Called", () => {
    const c = applyCallNext(issued(), at("2026-05-08T09:05:00Z"), newTicketEventId())
      .ticket as Called
    expect(guardActive(c)).toBeNull()
  })
})

describe("applyRecall", () => {
  const called = (): Called => {
    const { ticket } = applyCallNext(issued(), at("2026-05-08T09:05:00Z"), newTicketEventId())
    return ticket as Called
  }

  it("transitions Called → Waiting and emits a Recalled event", () => {
    const { ticket, event } = applyRecall(called(), at("2026-05-08T09:06:00Z"), newTicketEventId())
    expect(ticket.state).toBe("Waiting")
    expect(event.type).toBe("Recalled")
  })

  it("preserves the original seq so the ticket returns to the head", () => {
    const c = called()
    const { ticket } = applyRecall(c, at("2026-05-08T09:06:00Z"), newTicketEventId())
    expect(ticket.seq).toBe(c.seq)
  })

  it("drops calledAt / calledBy from the resulting Waiting variant", () => {
    const { ticket } = applyRecall(called(), at("2026-05-08T09:06:00Z"), newTicketEventId())
    expect("calledAt" in ticket).toBe(false)
    expect("calledBy" in ticket).toBe(false)
  })

  it("records who issued the recall on the event (defaults to staff)", () => {
    const c = called()
    const { event: e1 } = applyRecall(c, at("2026-05-08T09:06:00Z"), newTicketEventId())
    if (e1.type === "Recalled") expect(e1.recalledBy).toBe("staff")
    const { event: e2 } = applyRecall(c, at("2026-05-08T09:06:00Z"), newTicketEventId(), "system")
    if (e2.type === "Recalled") expect(e2.recalledBy).toBe("system")
  })
})

describe("invalidTransition", () => {
  it("synthesises an InvalidStateTransition error with the offending row", () => {
    const err = invalidTransition("Waiting", "MarkServed")
    expect(err._tag).toBe("InvalidStateTransition")
    expect(err.from).toBe("Waiting")
    expect(err.command).toBe("MarkServed")
  })

  it("accepts Recall as a command name", () => {
    const err = invalidTransition("Waiting", "Recall")
    expect(err.command).toBe("Recall")
  })
})
