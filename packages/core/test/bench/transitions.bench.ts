import { Temporal } from "@js-temporal/polyfill"
import { Schema } from "effect"
import { bench, describe } from "vitest"
import type { Called, Waiting } from "../../src/domain/queue/Ticket.js"
import { applyCallNext, applyIssue, applyMarkServed } from "../../src/domain/queue/transitions.js"
import { newTicketEventId, newTicketId } from "../../src/domain/types/EntityId.js"
import { NameKanaSchema } from "../../src/domain/value-objects/NameKana.js"
import { PhoneLast4Schema } from "../../src/domain/value-objects/PhoneLast4.js"

/**
 * Single-transition throughput. `applyIssue` / `applyCallNext` /
 * `applyMarkServed` are the hot path inside `dispatch`; a regression
 * here multiplies across every event the queue produces.
 */

const kana = Schema.decodeUnknownSync(NameKanaSchema)("ヤマダ タロウ")
const phone = Schema.decodeUnknownSync(PhoneLast4Schema)("1234")
const at = Temporal.Instant.from("2026-05-08T09:00:00Z")

describe("transitions — single-call throughput", () => {
  bench("applyIssue", () => {
    void applyIssue({
      id: newTicketId(),
      seq: 1,
      nameKana: kana,
      phoneLast4: phone,
      freeText: null,
      at,
      eventId: newTicketEventId(),
    })
  })

  // Call-next + mark-served require a state machine pre-step; build
  // the prior `Waiting` ticket once and reuse it for the inner-loop
  // iterations so the bench measures the transition function's cost,
  // not the fixture's. The narrowed locals carry the expected
  // type-state through the closures (the discriminated union erases
  // through the bench callback boundary otherwise).
  const seed = applyIssue({
    id: newTicketId(),
    seq: 1,
    nameKana: kana,
    phoneLast4: phone,
    freeText: null,
    at,
    eventId: newTicketEventId(),
  })
  const waiting = seed.ticket as Waiting

  bench("applyCallNext on a Waiting ticket", () => {
    void applyCallNext(waiting, at, newTicketEventId(), "staff")
  })

  const calledResult = applyCallNext(waiting, at, newTicketEventId(), "staff")
  const called = calledResult.ticket as Called
  bench("applyMarkServed on a Called ticket", () => {
    void applyMarkServed(called, at, newTicketEventId())
  })
})
