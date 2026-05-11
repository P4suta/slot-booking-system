import { Temporal } from "@js-temporal/polyfill"
import { describe, expect, it } from "vitest"
import type { Ticket } from "../../src/domain/queue/Ticket.js"
import type { TicketId } from "../../src/domain/types/EntityId.js"
import type { FreeText } from "../../src/domain/value-objects/FreeText.js"
import type { NameKana } from "../../src/domain/value-objects/NameKana.js"
import type { PhoneLast4 } from "../../src/domain/value-objects/PhoneLast4.js"
import { encodeTicket } from "../../src/projection/wire.js"

const NOW = Temporal.Instant.from("2026-05-11T10:00:00Z")
const ID_WAITING = "tkt_01j0a00000000000000000xxx1" as TicketId
const ID_CALLED = "tkt_01j0a00000000000000000xxx2" as TicketId

describe("encodeTicket", () => {
  it("encodes a decoded Waiting ticket into the JSON-safe wire shape", () => {
    const t: Ticket = {
      id: ID_WAITING,
      seq: 1,
      lane: "walkIn",
      displaySeq: 1,
      nameKana: "ヤマダ" as NameKana,
      phoneLast4: "1234" as PhoneLast4,
      freeText: null,
      issuedAt: NOW,
      appointmentAt: null,
      checkedInAt: null,
      state: "Waiting",
    }
    const encoded = encodeTicket(t)
    expect(encoded.state).toBe("Waiting")
    expect(encoded.id).toBe(ID_WAITING)
    expect(encoded.issuedAt).toBe("2026-05-11T10:00:00Z")
    expect(encoded.appointmentAt).toBeNull()
  })

  it("preserves PII fields and never-null timestamps for Called variants", () => {
    const t: Ticket = {
      id: ID_CALLED,
      seq: 2,
      lane: "reservation",
      displaySeq: 2,
      nameKana: "サトウ" as NameKana,
      phoneLast4: "5678" as PhoneLast4,
      freeText: "メモ" as FreeText,
      issuedAt: NOW,
      appointmentAt: NOW.add({ minutes: 30 }),
      checkedInAt: NOW,
      state: "Called",
      calledAt: NOW.add({ minutes: 31 }),
      calledBy: "staff",
    }
    const encoded = encodeTicket(t)
    expect(encoded.state).toBe("Called")
    expect(encoded.nameKana).toBe("サトウ")
    expect(encoded.phoneLast4).toBe("5678")
    expect(encoded.freeText).toBe("メモ")
    if (encoded.state === "Called") {
      expect(encoded.calledAt).toBe("2026-05-11T10:31:00Z")
      expect(encoded.calledBy).toBe("staff")
    }
  })
})
