import { Temporal } from "@js-temporal/polyfill"
import { Schema } from "effect"
import { bench, describe } from "vitest"
import { applyEvent, empty, replay } from "../../src/domain/queue/projection.js"
import type { Called, Waiting } from "../../src/domain/queue/Ticket.js"
import type { TicketEvent } from "../../src/domain/queue/TicketEvent.js"
import { applyCall, applyIssue, applyMarkServed } from "../../src/domain/queue/transitions.js"
import { newTicketEventId, newTicketId } from "../../src/domain/types/EntityId.js"
import { NameKanaSchema } from "../../src/domain/value-objects/NameKana.js"
import { PhoneLast4Schema } from "../../src/domain/value-objects/PhoneLast4.js"

/**
 * Replay-throughput baseline. The DO `load` path replays the
 * trailing event delta from the latest snapshot up to the current
 * revision (ADR-0059); regressions in `applyEvent` show up here
 * before they surface as user-visible request latency.
 *
 * Fixture: 1 000 events covering Issue → Call → MarkServed
 * triplets across 333 distinct tickets. Vitest bench reports
 * iterations per second; the CI regression gate (±20 %) lives in
 * the bench-baseline JSON and is checked outside this file.
 */

const kana = Schema.decodeUnknownSync(NameKanaSchema)("ヤマダ タロウ")
const phone = Schema.decodeUnknownSync(PhoneLast4Schema)("1234")
const at = (offsetSec: number) =>
  Temporal.Instant.from("2026-05-08T09:00:00Z").add({ seconds: offsetSec })

const buildFixture = (tickets: number): readonly TicketEvent[] => {
  const events: TicketEvent[] = []
  for (let i = 0; i < tickets; i += 1) {
    const id = newTicketId()
    const seq = i + 1
    const issue = applyIssue({
      id,
      seq,
      lane: "walkIn",
      displaySeq: seq,
      nameKana: kana,
      phoneLast4: phone,
      freeText: null,
      at: at(i * 3),
      eventId: newTicketEventId(),
    })
    events.push(issue.event)
    const waiting = issue.ticket as Waiting
    const call = applyCall(waiting, {
      at: at(i * 3 + 1),
      eventId: newTicketEventId(),
      calledBy: "staff",
    })
    events.push(call.event)
    const called = call.ticket as Called
    const served = applyMarkServed(called, at(i * 3 + 2), newTicketEventId())
    events.push(served.event)
  }
  return events
}

const fixture1k = buildFixture(333)

describe("event replay", () => {
  bench("replay(1000 events)", () => {
    void replay(fixture1k)
  })

  bench("events.reduce(applyEvent, empty) — explicit fold of 1000 events", () => {
    let acc = empty
    for (const ev of fixture1k) {
      acc = applyEvent(acc, ev)
    }
    void acc
  })
})
