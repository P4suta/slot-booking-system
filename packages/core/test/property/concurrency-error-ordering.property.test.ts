import { Temporal } from "@js-temporal/polyfill"
import { Schema } from "effect"
import * as fc from "fast-check"
import { describe, expect, it } from "vitest"
import { applyEvent, replay } from "../../src/domain/queue/projection.js"
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
 * Concurrency safety on the queue depends on the absorbing-state
 * lemma: once a ticket reaches a terminal state (`Served`,
 * `NoShow`, `Cancelled`), every subsequent event targeting it
 * is a no-op under `applyEvent`.
 *
 * In the live system this property protects the operator from a
 * delayed / re-driven command racing past the state transition
 * that already happened. The fact that those events fall on the
 * floor (no error tag stream is produced from `applyEvent` —
 * `applyEvent` is total) means the dispatch ordering of stale
 * commands cannot corrupt state, regardless of fiber schedule.
 *
 * Tested invariants:
 *   - For any history that drives a ticket to a terminal state,
 *     applying the entire history's events again leaves the
 *     terminal ticket unchanged.
 *   - For any pair of histories interleaved at every split point,
 *     the projected ticket count + per-ticket terminal state are
 *     determined by the union of events, not the interleaving.
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

const TERMINAL = new Set(["Served", "NoShow", "Cancelled"])

const NUM_RUNS = numRuns(80, 200)

describe("concurrency error-tag ordering (property)", () => {
  it("absorbing terminal states are unchanged when stale events re-arrive", () => {
    fc.assert(
      fc.property(fc.array(stepArb, { maxLength: 24 }), (steps) => {
        const events = drive(steps)
        const before = replay(events)
        const after = events.reduce(applyEvent, before)
        for (const [id, ticket] of before.tickets) {
          if (!TERMINAL.has(ticket.state)) continue
          const replayedAfter = after.tickets.get(id)
          expect(replayedAfter, `ticket ${id} disappeared after re-driving`).toBeDefined()
          expect(replayedAfter?.state).toBe(ticket.state)
          expect(replayedAfter?.seq).toBe(ticket.seq)
        }
      }),
      { numRuns: NUM_RUNS, verbose: false },
    )
  })

  it("interleaving two histories at any split point yields the same ticket-count / terminal-state set", () => {
    fc.assert(
      fc.property(
        fc.tuple(fc.array(stepArb, { maxLength: 12 }), fc.array(stepArb, { maxLength: 12 })),
        ([leftSteps, rightSteps]) => {
          const left = drive(leftSteps)
          const right = drive(rightSteps)
          // The two histories use freshly generated ticket ids
          // (newTicketId) so their key sets are disjoint; any
          // interleaving therefore commutes at the ticket-set
          // level. We assert: for every split point i ∈ [0, |left|],
          // the projection of (left[0:i] ++ right ++ left[i:])
          // has the same ticket count and the same multiset of
          // terminal states as the projection of left ++ right.
          const baseline = replay([...left, ...right])
          for (let i = 0; i <= left.length; i += 1) {
            const interleaved = [...left.slice(0, i), ...right, ...left.slice(i)]
            const projected = replay(interleaved)
            expect(projected.tickets.size).toBe(baseline.tickets.size)
            const baseStates = [...baseline.tickets.values()].map((t) => t.state).sort()
            const projStates = [...projected.tickets.values()].map((t) => t.state).sort()
            expect(projStates).toEqual(baseStates)
          }
        },
      ),
      { numRuns: NUM_RUNS, verbose: false },
    )
  })
})
