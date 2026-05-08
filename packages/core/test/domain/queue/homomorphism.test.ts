import { Temporal } from "@js-temporal/polyfill"
import { Schema } from "effect"
import * as fc from "fast-check"
import { describe, expect, it } from "vitest"
import { applyEvent, empty, replay } from "../../../src/domain/queue/projection.js"
import type { Called, Ticket, Waiting } from "../../../src/domain/queue/Ticket.js"
import {
  applyCallNext,
  applyCancel,
  applyIssue,
  applyMarkNoShow,
  applyMarkServed,
  applyRecall,
} from "../../../src/domain/queue/transitions.js"
import { newTicketEventId, newTicketId } from "../../../src/domain/types/EntityId.js"
import { FreeTextSchema } from "../../../src/domain/value-objects/FreeText.js"
import { NameKanaSchema } from "../../../src/domain/value-objects/NameKana.js"
import { PhoneLast4Schema } from "../../../src/domain/value-objects/PhoneLast4.js"

const kana = Schema.decodeUnknownSync(NameKanaSchema)("ヤマダ タロウ")
const phone = Schema.decodeUnknownSync(PhoneLast4Schema)("1234")
const free = Schema.decodeUnknownSync(FreeTextSchema)("用件")
const at = (offsetSec: number) =>
  Temporal.Instant.from("2026-05-08T09:00:00Z").add({ seconds: offsetSec })

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

/**
 * Drive a sequence of lifecycle steps through `transitions.ts`, building
 * an event log + the per-transition aggregate state. After every step,
 * the projection (replay of the events so far) is expected to carry the
 * same ticket the transition returned — `transitions ↔ applyEvent` is a
 * homomorphism over the free monoid of events.
 */
const drive = (
  steps: readonly Step[],
): {
  readonly events: readonly import("../../../src/domain/queue/TicketEvent.js").TicketEvent[]
  readonly tickets: ReadonlyMap<string, Ticket>
} => {
  const events: import("../../../src/domain/queue/TicketEvent.js").TicketEvent[] = []
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
        // Model the `CallNext` use case's "at most one serving" guard:
        // skip if anyone is already in `Called`, otherwise pick the
        // lowest-seq Waiting ticket (queue head).
        const anyCalled = [...tickets.values()].some((t) => t.state === "Called")
        if (anyCalled) continue
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
        const cancellable = [...tickets.values()].find(
          (t) => t.state === "Waiting" || t.state === "Called",
        )
        if (cancellable === undefined) continue
        const out = applyCancel(
          cancellable as Waiting | Called,
          at(tick),
          newTicketEventId(),
          "customer",
          "user-cancelled",
        )
        events.push(out.event)
        tickets.set(out.ticket.id, out.ticket)
        continue
      }
    }
  }

  return { events, tickets }
}

describe("transitions ↔ applyEvent homomorphism", () => {
  it("replay(events) ≡ aggregated tickets across any valid sequence", () => {
    fc.assert(
      fc.property(fc.array(stepArb, { maxLength: 30 }), (steps) => {
        const { events, tickets } = drive(steps)
        const projected = replay(events)
        expect(projected.tickets.size).toBe(tickets.size)
        for (const [id, ticket] of tickets) {
          const p = projected.tickets.get(id as never)
          expect(p, `ticket ${id} missing in projection`).toBeDefined()
          expect(p?.state).toBe(ticket.state)
          expect(p?.seq).toBe(ticket.seq)
        }
      }),
      { numRuns: 100 },
    )
  })

  it("invariants: serving count ≤ 1 and seq is strictly monotonic over Issued events", () => {
    fc.assert(
      fc.property(fc.array(stepArb, { maxLength: 30 }), (steps) => {
        const { events } = drive(steps)
        const snap = replay(events)
        const calledCount = [...snap.tickets.values()].filter((t) => t.state === "Called").length
        expect(calledCount).toBeLessThanOrEqual(1)

        const issued = events.filter((e) => e.type === "Issued")
        for (let i = 1; i < issued.length; i += 1) {
          // Issued events arrive monotonically in the drive order;
          // applyIssue assigns `seq = tickets.size + 1` per call.
          expect((issued[i] as { seq: number }).seq).toBeGreaterThan(
            (issued[i - 1] as { seq: number }).seq,
          )
        }
      }),
      { numRuns: 100 },
    )
  })

  it("the empty event list folds to the empty snapshot (identity)", () => {
    expect(replay([])).toEqual(empty)
  })

  it("events.reduce(applyEvent, empty) ≡ replay(events)", () => {
    fc.assert(
      fc.property(fc.array(stepArb, { maxLength: 20 }), (steps) => {
        const { events } = drive(steps)
        const folded = events.reduce(applyEvent, empty)
        const replayed = replay(events)
        expect(folded.tickets.size).toBe(replayed.tickets.size)
      }),
      { numRuns: 50 },
    )
  })
})
