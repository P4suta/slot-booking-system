import { Temporal } from "@js-temporal/polyfill"
import { Schema } from "effect"
import * as fc from "fast-check"
import { describe, expect, it } from "vitest"
import { applyEvent, empty } from "../../src/domain/queue/projection.js"
import type { Called, Ticket, Waiting } from "../../src/domain/queue/Ticket.js"
import type { TicketEvent } from "../../src/domain/queue/TicketEvent.js"
import {
  applyCall,
  applyCancel,
  applyIssue,
  applyMarkNoShow,
  applyMarkServed,
  applyRecall,
} from "../../src/domain/queue/transitions.js"
import { newTicketEventId, newTicketId } from "../../src/domain/types/EntityId.js"
import { FreeTextSchema } from "../../src/domain/value-objects/FreeText.js"
import { NameKanaSchema } from "../../src/domain/value-objects/NameKana.js"
import { PhoneLast4Schema } from "../../src/domain/value-objects/PhoneLast4.js"
import { numRuns } from "../_arb/numRuns.js"

/**
 * Idempotency under `applyEvent` is the load-bearing invariant
 * behind the at-least-once outbox dispatch (ADR-0059): a redrived
 * event must not double-apply when its first application already
 * completed.
 *
 * For Issued the proof is `Map.set` — same key, same struct, same
 * map. For the other six tags the proof is the prior-state guard:
 * a second application sees the wrong source state and short-
 * circuits to the unchanged snapshot.
 */
const kana = Schema.decodeUnknownSync(NameKanaSchema)("ヤマダ タロウ")
const phone = Schema.decodeUnknownSync(PhoneLast4Schema)("1234")
const free = Schema.decodeUnknownSync(FreeTextSchema)("用件")
const at = (sec: number) => Temporal.Instant.from("2026-05-08T09:00:00Z").add({ seconds: sec })

type Step =
  | { readonly kind: "issue" }
  | { readonly kind: "call" }
  | { readonly kind: "recall" }
  | { readonly kind: "served" }
  | { readonly kind: "noShow" }
  | { readonly kind: "cancel" }

const stepArb: fc.Arbitrary<Step> = fc.oneof(
  fc.constant<Step>({ kind: "issue" }),
  fc.constant<Step>({ kind: "call" }),
  fc.constant<Step>({ kind: "recall" }),
  fc.constant<Step>({ kind: "served" }),
  fc.constant<Step>({ kind: "noShow" }),
  fc.constant<Step>({ kind: "cancel" }),
)

const drive = (steps: readonly Step[]): readonly TicketEvent[] => {
  const events: TicketEvent[] = []
  const tickets = new Map<string, Ticket>()
  let tick = 0
  for (const step of steps) {
    tick += 1
    switch (step.kind) {
      case "issue": {
        const id = newTicketId()
        const seq = tickets.size + 1
        const out = applyIssue({
          id,
          seq,
          lane: "walkIn",
          displaySeq: seq,
          nameKana: kana,
          phoneLast4: phone,
          freeText: free,
          appointmentAt: null,
          at: at(tick),
          eventId: newTicketEventId(),
        })
        events.push(out.event)
        tickets.set(id, out.ticket)
        continue
      }
      case "call": {
        if ([...tickets.values()].some((t) => t.state === "Called")) continue
        const head = [...tickets.values()]
          .filter((t): t is Waiting => t.state === "Waiting")
          .sort((a, b) => a.displaySeq - b.displaySeq)[0]
        if (head === undefined) continue
        const out = applyCall(head, { at: at(tick), eventId: newTicketEventId() })
        events.push(out.event)
        tickets.set(out.ticket.id, out.ticket)
        continue
      }
      case "recall": {
        const called = [...tickets.values()].find((t): t is Called => t.state === "Called")
        if (called === undefined) continue
        const out = applyRecall(called, at(tick), newTicketEventId())
        events.push(out.event)
        tickets.set(out.ticket.id, out.ticket)
        continue
      }
      case "served": {
        const called = [...tickets.values()].find((t): t is Called => t.state === "Called")
        if (called === undefined) continue
        const out = applyMarkServed(called, at(tick), newTicketEventId())
        events.push(out.event)
        tickets.set(out.ticket.id, out.ticket)
        continue
      }
      case "noShow": {
        const called = [...tickets.values()].find((t): t is Called => t.state === "Called")
        if (called === undefined) continue
        const out = applyMarkNoShow(called, at(tick), newTicketEventId(), "system")
        events.push(out.event)
        tickets.set(out.ticket.id, out.ticket)
        continue
      }
      case "cancel": {
        const target = [...tickets.values()].find(
          (t) => t.state === "Waiting" || t.state === "Called",
        )
        if (target === undefined) continue
        const out = applyCancel(target, at(tick), newTicketEventId(), "customer", "user-cancelled")
        events.push(out.event)
        tickets.set(out.ticket.id, out.ticket)
        continue
      }
    }
  }
  return events
}

const NUM_RUNS = numRuns(80, 200)

describe("applyEvent idempotency (property)", () => {
  it("applyEvent(s, e) deepEquals applyEvent(applyEvent(s, e), e) at every fold step", () => {
    fc.assert(
      fc.property(fc.array(stepArb, { maxLength: 24 }), (steps) => {
        const events = drive(steps)
        let snap = empty
        for (const e of events) {
          const once = applyEvent(snap, e)
          const twice = applyEvent(once, e)
          expect(twice.tickets.size).toBe(once.tickets.size)
          for (const [id, t] of once.tickets) {
            expect(twice.tickets.get(id)).toEqual(t)
          }
          snap = once
        }
      }),
      { numRuns: NUM_RUNS, verbose: false },
    )
  })

  it("Issued is idempotent even when the snapshot already has the ticket", () => {
    fc.assert(
      fc.property(fc.array(stepArb, { maxLength: 12 }), (steps) => {
        const events = drive(steps)
        const issued = events.find((e) => e.type === "Issued")
        if (issued === undefined) return
        const once = applyEvent(empty, issued)
        const twice = applyEvent(once, issued)
        expect(twice.tickets.size).toBe(once.tickets.size)
        for (const [id, t] of once.tickets) {
          expect(twice.tickets.get(id)).toEqual(t)
        }
      }),
      { numRuns: NUM_RUNS, verbose: false },
    )
  })
})
