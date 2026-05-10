import { Temporal } from "@js-temporal/polyfill"
import { Schema } from "effect"
import { bench, describe } from "vitest"
import { head } from "../../src/domain/queue/projection.js"
import type { Ticket } from "../../src/domain/queue/Ticket.js"
import type { TicketId } from "../../src/domain/types/EntityId.js"
import { newTicketId } from "../../src/domain/types/EntityId.js"
import { NameKanaSchema } from "../../src/domain/value-objects/NameKana.js"
import { PhoneLast4Schema } from "../../src/domain/value-objects/PhoneLast4.js"

/**
 * Projection-query throughput. The HTTP `GET /api/v1/queue` route
 * runs `head` over the live tickets map; benchmark the lookup at
 * realistic shop sizes so a future O(n²) regression surfaces.
 */

const kana = Schema.decodeUnknownSync(NameKanaSchema)("ヤマダ タロウ")
const phone = Schema.decodeUnknownSync(PhoneLast4Schema)("1234")
const issuedAt = Temporal.Instant.from("2026-05-08T09:00:00Z")

const buildSnapshot = (waitingCount: number): { tickets: Map<TicketId, Ticket> } => {
  const tickets = new Map<TicketId, Ticket>()
  for (let i = 0; i < waitingCount; i += 1) {
    const id = newTicketId()
    tickets.set(id, {
      id,
      seq: i + 1,
      lane: "walkIn",
      displaySeq: i + 1,
      state: "Waiting",
      nameKana: kana,
      phoneLast4: phone,
      freeText: null,
      issuedAt,
      appointmentAt: null,
      checkedInAt: null,
    } satisfies Ticket)
  }
  return { tickets }
}

const snapshot100 = buildSnapshot(100)
const snapshot1000 = buildSnapshot(1000)

describe("projection.head — head-of-queue lookup", () => {
  bench("head over 100 waiting tickets", () => {
    void head(snapshot100)
  })

  bench("head over 1 000 waiting tickets", () => {
    void head(snapshot1000)
  })
})
