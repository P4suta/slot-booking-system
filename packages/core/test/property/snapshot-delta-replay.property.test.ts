import { Temporal } from "@js-temporal/polyfill"
import { Schema } from "effect"
import * as fc from "fast-check"
import { describe, expect, it } from "vitest"
import { applyMany, replay } from "../../src/domain/queue/projection.js"
import type { Called, Ticket, Waiting } from "../../src/domain/queue/Ticket.js"
import type { TicketEvent } from "../../src/domain/queue/TicketEvent.js"
import {
  applyCallNext,
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
 * The K=200 snapshot+delta dispatch path (ADR-0059) is correct
 * iff the projection is a monoid homomorphism over the free
 * monoid on `TicketEvent`:
 *
 *     replay(xs ++ ys) ≡ applyMany(replay(xs), ys)
 *
 * Holding this property pins the legality of "load latest
 * snapshot, then fold the delta since" against "fold the full
 * event log from empty" — the operator-side optimisation must
 * not drift away from the SoT semantics.
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
        const out = applyIssue({
          id,
          seq: tickets.size + 1,
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
          .sort((a, b) => a.seq - b.seq)[0]
        if (head === undefined) continue
        const out = applyCallNext(head, at(tick), newTicketEventId())
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

const equalSnap = (
  l: { tickets: ReadonlyMap<string, Ticket> },
  r: { tickets: ReadonlyMap<string, Ticket> },
): void => {
  expect(r.tickets.size).toBe(l.tickets.size)
  for (const [id, t] of l.tickets) {
    expect(r.tickets.get(id)).toEqual(t)
  }
}

const NUM_RUNS = numRuns(80, 200)

describe("snapshot-delta replay homomorphism (property)", () => {
  it("replay(xs ++ ys) deepEquals applyMany(replay(xs), ys) for every split", () => {
    fc.assert(
      fc.property(
        fc.array(stepArb, { maxLength: 24 }).chain((steps) => {
          const events = drive(steps)
          return fc.tuple(fc.constant(events), fc.integer({ min: 0, max: events.length }))
        }),
        ([events, split]) => {
          const xs = events.slice(0, split)
          const ys = events.slice(split)
          const direct = replay(events)
          const split2 = applyMany(replay(xs), ys)
          equalSnap(direct, split2)
        },
      ),
      { numRuns: NUM_RUNS, verbose: false },
    )
  })

  it("replay(empty stream) ≡ identity (no tickets)", () => {
    expect(replay([]).tickets.size).toBe(0)
  })
})
