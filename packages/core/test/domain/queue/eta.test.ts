import { Temporal } from "@js-temporal/polyfill"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { emptyMetric, etaOf } from "../../../src/domain/queue/eta.js"
import { replay } from "../../../src/domain/queue/projection.js"
import type { Ticket, Waiting } from "../../../src/domain/queue/Ticket.js"
import { applyCall, applyIssue } from "../../../src/domain/queue/transitions.js"
import { newTicketEventId, newTicketId, type TicketId } from "../../../src/domain/types/EntityId.js"
import { FreeTextSchema } from "../../../src/domain/value-objects/FreeText.js"
import { NameKanaSchema } from "../../../src/domain/value-objects/NameKana.js"
import { PhoneLast4Schema } from "../../../src/domain/value-objects/PhoneLast4.js"

const at = (iso: string) => Temporal.Instant.from(iso)
const kana = Schema.decodeUnknownSync(NameKanaSchema)("ヤマダ タロウ")
const phone = Schema.decodeUnknownSync(PhoneLast4Schema)("1234")
const free = Schema.decodeUnknownSync(FreeTextSchema)("用件")
const NOW = at("2026-05-08T13:55:00Z")

const issue = (
  seq: number,
  opts?: { lane?: "walkIn" | "reservation"; appointmentAt?: Temporal.Instant | null },
) => {
  const id = newTicketId()
  return applyIssue({
    id,
    seq,
    lane: opts?.lane ?? "walkIn",
    displaySeq: seq,
    nameKana: kana,
    phoneLast4: phone,
    freeText: free,
    appointmentAt: opts?.appointmentAt ?? null,
    at: at(`2026-05-08T09:0${String(seq)}:00Z`),
    eventId: newTicketEventId(),
  })
}

describe("etaOf — ADR-0066 wait-time projection", () => {
  it("returns null for an unknown ticketId", () => {
    const empty = { tickets: new Map<TicketId, Ticket>() }
    expect(etaOf(empty, newTicketId(), emptyMetric, NOW)).toBeNull()
  })

  it("returns null for a non-Waiting ticket (Called)", () => {
    const a = issue(1)
    const call = applyCall(a.ticket as Waiting, {
      at: at("2026-05-08T13:50:00Z"),
      eventId: newTicketEventId(),
    })
    const snap = replay([a.event, call.event])
    expect(etaOf(snap, a.ticket.id, { avgServingMs: 60_000, sampleCount: 5 }, NOW)).toBeNull()
  })

  it("walk-in ticket: ETA = now + position × avgServingMs", () => {
    const a = issue(1)
    const b = issue(2)
    const c = issue(3)
    const snap = replay([a.event, b.event, c.event])
    const metric = { avgServingMs: 5 * 60_000, sampleCount: 10 } // 5min/customer
    // Position of a is 0 (head); ETA = NOW
    expect(etaOf(snap, a.ticket.id, metric, NOW)?.toString()).toBe(NOW.toString())
    // Position of b is 1; ETA = NOW + 5min
    expect(etaOf(snap, b.ticket.id, metric, NOW)?.toString()).toBe(
      NOW.add({ minutes: 5 }).toString(),
    )
    // Position of c is 2; ETA = NOW + 10min
    expect(etaOf(snap, c.ticket.id, metric, NOW)?.toString()).toBe(
      NOW.add({ minutes: 10 }).toString(),
    )
  })

  it("reservation ticket: ETA never goes earlier than appointmentAt", () => {
    const apptAt = at("2026-05-08T14:30:00Z") // 35min from NOW
    const a = issue(1, { lane: "reservation", appointmentAt: apptAt })
    const snap = replay([a.event])
    // computed = NOW + 0min × avg = NOW (earlier than apptAt)
    // expected: clamps to apptAt
    expect(
      etaOf(snap, a.ticket.id, { avgServingMs: 60_000, sampleCount: 5 }, NOW)?.toString(),
    ).toBe(apptAt.toString())
  })

  it("reservation ticket: ETA = computed when computed >= appointmentAt", () => {
    const apptAt = at("2026-05-08T13:00:00Z") // already passed
    const a = issue(1, { lane: "reservation", appointmentAt: apptAt })
    const snap = replay([a.event])
    // computed = NOW; NOW > apptAt; expected: NOW
    expect(
      etaOf(snap, a.ticket.id, { avgServingMs: 60_000, sampleCount: 5 }, NOW)?.toString(),
    ).toBe(NOW.toString())
  })

  it("emptyMetric (zero avg) gives ETA = now for any walk-in position", () => {
    const a = issue(1)
    const b = issue(2)
    const snap = replay([a.event, b.event])
    expect(etaOf(snap, b.ticket.id, emptyMetric, NOW)?.toString()).toBe(NOW.toString())
  })
})
