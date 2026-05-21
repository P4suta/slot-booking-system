import { Temporal } from "@js-temporal/polyfill"
import { Effect, Layer, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { TicketRepository } from "../../../../src/application/ports/EventSourcedRepository.js"
import {
  CallBatch,
  CallNext,
  CallSpecific,
  CancelTicket,
  CheckIn,
  IssueTicket,
  LapseAppointment,
  MarkNoShow,
  MarkServed,
  MoveToOverdue,
  Nudge,
  Recall,
  Reorder,
  RescheduleTicket,
} from "../../../../src/application/usecases/queue/index.js"
import { AggregateNotFoundError } from "../../../../src/domain/errors/Errors.js"
import { applyIssue } from "../../../../src/domain/queue/transitions.js"
import { newTicketEventId, newTicketId } from "../../../../src/domain/types/EntityId.js"
import { BusinessTimeZoneSchema } from "../../../../src/domain/value-objects/BusinessTimeZone.js"
import type { CustomerHandle } from "../../../../src/domain/value-objects/CustomerHandle.js"
import { NameKanaSchema } from "../../../../src/domain/value-objects/NameKana.js"
import { PhoneLast4Schema } from "../../../../src/domain/value-objects/PhoneLast4.js"
import { SystemClockLive } from "../../../../src/infrastructure/clock/SystemClockLive.js"
import { InMemoryTicketRepositoryLive } from "../../../../src/infrastructure/eventsourced/InMemoryEventSourcedRepositoryLive.js"
import { DeterministicIdGeneratorLive } from "../../../../src/infrastructure/id/DeterministicIdGeneratorLive.js"
import { SilentLoggerLive } from "../../../../src/infrastructure/logger/SilentLoggerLive.js"

const handle = (kana: string, p4: string): CustomerHandle => ({
  nameKana: Schema.decodeUnknownSync(NameKanaSchema)(kana),
  phoneLast4: Schema.decodeUnknownSync(PhoneLast4Schema)(p4),
})

/**
 * Each test bundles its sequence of use-case calls into one
 * `Effect.gen` block so the InMemory repo's `Ref<Map>` lives inside
 * a single Effect runtime / Layer scope. Splitting the calls across
 * multiple `Effect.runPromise` boundaries used to rebuild the layer
 * and reset the Ref between calls.
 */
const makeEnv = () =>
  Layer.mergeAll(
    SystemClockLive,
    DeterministicIdGeneratorLive,
    InMemoryTicketRepositoryLive,
    SilentLoggerLive,
  )

const eitherEffect = <A, E, R>(eff: Effect.Effect<A, E, R>) =>
  Effect.matchEffect(eff, {
    onSuccess: (value) => Effect.succeed({ ok: true as const, value }),
    onFailure: (error) => Effect.succeed({ ok: false as const, error }),
  })

const runScenario = <A, E, R>(scenario: Effect.Effect<A, E, R>): Promise<A> =>
  Effect.runPromise(scenario.pipe(Effect.provide(makeEnv())) as unknown as Effect.Effect<A>)

describe("queue lifecycle round-trip", () => {
  it("issue → callNext → markServed", async () =>
    runScenario(
      Effect.gen(function* () {
        const t1 = yield* IssueTicket({
          handle: handle("ヤマダ タロウ", "1234"),
          freeText: null,
        })
        expect(t1.state).toBe("Waiting")
        const called = yield* CallNext()
        expect(called.state).toBe("Called")
        const served = yield* MarkServed(t1.id)
        expect(served.state).toBe("Served")
      }),
    ))

  it("issue → callNext → markNoShow (system actor)", async () =>
    runScenario(
      Effect.gen(function* () {
        const t1 = yield* IssueTicket({
          handle: handle("ヤマダ タロウ", "1234"),
          freeText: null,
        })
        yield* CallNext()
        const ns = yield* MarkNoShow(t1.id, "system")
        expect(ns.state).toBe("NoShow")
      }),
    ))

  it("issue → cancel by customer (handle verified)", async () =>
    runScenario(
      Effect.gen(function* () {
        const h = handle("ヤマダ タロウ", "1234")
        const t1 = yield* IssueTicket({ handle: h, freeText: null })
        const cancelled = yield* CancelTicket(t1.id, "customer", "changed plans", h)
        expect(cancelled.state).toBe("Cancelled")
      }),
    ))

  it("cancel with mismatched handle yields PhoneMismatch", async () =>
    runScenario(
      Effect.gen(function* () {
        const t1 = yield* IssueTicket({
          handle: handle("ヤマダ タロウ", "1234"),
          freeText: null,
        })
        const wrong = handle("サトウ ジロウ", "1234")
        const r = yield* eitherEffect(CancelTicket(t1.id, "customer", "x", wrong))
        expect(r.ok).toBe(false)
        if (!r.ok) {
          const err = r.error as { _tag: string }
          expect(err._tag).toBe("PhoneMismatch")
        }
      }),
    ))

  it("CallNext on empty queue yields QueueEmpty", async () =>
    runScenario(
      Effect.gen(function* () {
        const r = yield* eitherEffect(CallNext())
        expect(r.ok).toBe(false)
        if (!r.ok) {
          const err = r.error as { _tag: string }
          expect(err._tag).toBe("QueueEmpty")
        }
      }),
    ))

  it("MarkServed against a Waiting ticket yields InvalidStateTransition", async () =>
    runScenario(
      Effect.gen(function* () {
        const t1 = yield* IssueTicket({
          handle: handle("ヤマダ タロウ", "1234"),
          freeText: null,
        })
        const r = yield* eitherEffect(MarkServed(t1.id))
        expect(r.ok).toBe(false)
        if (!r.ok) {
          const err = r.error as { _tag: string }
          expect(err._tag).toBe("InvalidStateTransition")
        }
      }),
    ))

  it("MarkServed on a non-existent ticket yields TicketNotFound", async () =>
    runScenario(
      Effect.gen(function* () {
        const r = yield* eitherEffect(MarkServed("tkt_00000000000000000000000000" as never))
        expect(r.ok).toBe(false)
        if (!r.ok) {
          const err = r.error as { _tag: string }
          expect(err._tag).toBe("TicketNotFound")
        }
      }),
    ))

  it("issue → callNext → recall returns the ticket to Waiting and re-callable", async () =>
    runScenario(
      Effect.gen(function* () {
        const t1 = yield* IssueTicket({
          handle: handle("ヤマダ タロウ", "1234"),
          freeText: null,
        })
        const called = yield* CallNext()
        expect(called.id).toBe(t1.id)
        const recalled = yield* Recall(t1.id)
        expect(recalled.state).toBe("Waiting")
        expect(recalled.id).toBe(t1.id)
        const calledAgain = yield* CallNext()
        expect(calledAgain.id).toBe(t1.id)
        expect(calledAgain.state).toBe("Called")
      }),
    ))

  it("Recall on a Waiting ticket yields InvalidStateTransition", async () =>
    runScenario(
      Effect.gen(function* () {
        const t1 = yield* IssueTicket({
          handle: handle("ヤマダ タロウ", "1234"),
          freeText: null,
        })
        const r = yield* eitherEffect(Recall(t1.id))
        expect(r.ok).toBe(false)
        if (!r.ok) {
          const err = r.error as { _tag: string; command?: string }
          expect(err._tag).toBe("InvalidStateTransition")
          expect(err.command).toBe("Recall")
        }
      }),
    ))

  it("Recall on a Served ticket yields AlreadyCompleted", async () =>
    runScenario(
      Effect.gen(function* () {
        const t1 = yield* IssueTicket({
          handle: handle("ヤマダ タロウ", "1234"),
          freeText: null,
        })
        yield* CallNext()
        yield* MarkServed(t1.id)
        const r = yield* eitherEffect(Recall(t1.id))
        expect(r.ok).toBe(false)
        if (!r.ok) {
          const err = r.error as { _tag: string }
          expect(err._tag).toBe("AlreadyCompleted")
        }
      }),
    ))

  it("Recall on a non-existent ticket yields TicketNotFound", async () =>
    runScenario(
      Effect.gen(function* () {
        const r = yield* eitherEffect(Recall("tkt_00000000000000000000000000" as never))
        expect(r.ok).toBe(false)
        if (!r.ok) {
          const err = r.error as { _tag: string }
          expect(err._tag).toBe("TicketNotFound")
        }
      }),
    ))

  it("MarkNoShow against a Waiting ticket yields InvalidStateTransition", async () =>
    runScenario(
      Effect.gen(function* () {
        const t1 = yield* IssueTicket({
          handle: handle("ヤマダ タロウ", "1234"),
          freeText: null,
        })
        const r = yield* eitherEffect(MarkNoShow(t1.id))
        expect(r.ok).toBe(false)
        if (!r.ok) {
          const err = r.error as { _tag: string; command?: string }
          expect(err._tag).toBe("InvalidStateTransition")
          expect(err.command).toBe("MarkNoShow")
        }
      }),
    ))

  it("MarkServed against a Cancelled ticket yields AlreadyCancelled (terminal guard)", async () =>
    runScenario(
      Effect.gen(function* () {
        const h = handle("ヤマダ タロウ", "1234")
        const t1 = yield* IssueTicket({ handle: h, freeText: null })
        yield* CancelTicket(t1.id, "customer", "x", h)
        const r = yield* eitherEffect(MarkServed(t1.id))
        expect(r.ok).toBe(false)
        if (!r.ok) {
          const err = r.error as { _tag: string }
          expect(err._tag).toBe("AlreadyCancelled")
        }
      }),
    ))

  it("MarkNoShow against a Cancelled ticket yields AlreadyCancelled (terminal guard)", async () =>
    runScenario(
      Effect.gen(function* () {
        const h = handle("ヤマダ タロウ", "1234")
        const t1 = yield* IssueTicket({ handle: h, freeText: null })
        yield* CancelTicket(t1.id, "customer", "x", h)
        const r = yield* eitherEffect(MarkNoShow(t1.id))
        expect(r.ok).toBe(false)
        if (!r.ok) {
          const err = r.error as { _tag: string }
          expect(err._tag).toBe("AlreadyCancelled")
        }
      }),
    ))

  it("CancelTicket on a Cancelled ticket yields AlreadyCancelled (terminal guard)", async () =>
    runScenario(
      Effect.gen(function* () {
        const h = handle("ヤマダ タロウ", "1234")
        const t1 = yield* IssueTicket({ handle: h, freeText: null })
        yield* CancelTicket(t1.id, "customer", "first", h)
        const r = yield* eitherEffect(CancelTicket(t1.id, "customer", "second", h))
        expect(r.ok).toBe(false)
        if (!r.ok) {
          const err = r.error as { _tag: string }
          expect(err._tag).toBe("AlreadyCancelled")
        }
      }),
    ))

  it("staff CancelTicket (no handle) succeeds against Waiting", async () =>
    runScenario(
      Effect.gen(function* () {
        const t1 = yield* IssueTicket({
          handle: handle("ヤマダ タロウ", "1234"),
          freeText: null,
        })
        const cancelled = yield* CancelTicket(t1.id, "staff", "shop closing")
        expect(cancelled.state).toBe("Cancelled")
      }),
    ))

  it("staff CancelTicket against a Cancelled ticket yields AlreadyCancelled", async () =>
    runScenario(
      Effect.gen(function* () {
        const h = handle("ヤマダ タロウ", "1234")
        const t1 = yield* IssueTicket({ handle: h, freeText: null })
        yield* CancelTicket(t1.id, "customer", "first", h)
        // Staff path (no handle) hits guardActive on a terminal ticket.
        const r = yield* eitherEffect(CancelTicket(t1.id, "staff", "second"))
        expect(r.ok).toBe(false)
        if (!r.ok) {
          const err = r.error as { _tag: string }
          expect(err._tag).toBe("AlreadyCancelled")
        }
      }),
    ))

  it("ADR-0072: CancelTicket from Overdue recovers stale nudge state (staff path)", async () =>
    runScenario(
      Effect.gen(function* () {
        const t1 = yield* IssueTicket({
          handle: handle("ヤマダ タロウ", "1234"),
          freeText: null,
        })
        yield* CallNext()
        const overdue = yield* MoveToOverdue(t1.id)
        expect(overdue.state).toBe("Overdue")
        const cancelled = yield* CancelTicket(t1.id, "staff", "no-show-confirmed")
        expect(cancelled.state).toBe("Cancelled")
        if (cancelled.state === "Cancelled") {
          expect(cancelled.reason).toBe("no-show-confirmed")
        }
      }),
    ))

  it("ADR-0072: customer CancelTicket from Overdue with handle succeeds", async () =>
    runScenario(
      Effect.gen(function* () {
        const h = handle("ヤマダ タロウ", "1234")
        const t1 = yield* IssueTicket({ handle: h, freeText: null })
        yield* CallNext()
        yield* MoveToOverdue(t1.id)
        const cancelled = yield* CancelTicket(t1.id, "customer", "abort", h)
        expect(cancelled.state).toBe("Cancelled")
      }),
    ))

  it("CancelTicket on a non-existent ticket (customer path) yields TicketNotFound", async () =>
    runScenario(
      Effect.gen(function* () {
        const r = yield* eitherEffect(
          CancelTicket(
            "tkt_00000000000000000000000000" as never,
            "customer",
            "x",
            handle("ヤマダ タロウ", "1234"),
          ),
        )
        expect(r.ok).toBe(false)
        if (!r.ok) {
          const err = r.error as { _tag: string }
          expect(err._tag).toBe("TicketNotFound")
        }
      }),
    ))

  it("CancelTicket on a non-existent ticket (staff path) yields TicketNotFound", async () =>
    runScenario(
      Effect.gen(function* () {
        const r = yield* eitherEffect(
          CancelTicket("tkt_00000000000000000000000000" as never, "staff", "x"),
        )
        expect(r.ok).toBe(false)
        if (!r.ok) {
          const err = r.error as { _tag: string }
          expect(err._tag).toBe("TicketNotFound")
        }
      }),
    ))

  it("CallSpecific against a Waiting ticket transitions it to Called (ADR-0065)", async () =>
    runScenario(
      Effect.gen(function* () {
        const t1 = yield* IssueTicket({
          handle: handle("ヤマダ タロウ", "1234"),
          freeText: null,
        })
        const called = yield* CallSpecific(t1.id)
        expect(called.state).toBe("Called")
        expect(called.id).toBe(t1.id)
      }),
    ))

  it("CallSpecific against a Called ticket yields InvalidStateTransition", async () =>
    runScenario(
      Effect.gen(function* () {
        const t1 = yield* IssueTicket({
          handle: handle("ヤマダ タロウ", "1234"),
          freeText: null,
        })
        yield* CallNext()
        const r = yield* eitherEffect(CallSpecific(t1.id))
        expect(r.ok).toBe(false)
        if (!r.ok) expect((r.error as { _tag: string })._tag).toBe("InvalidStateTransition")
      }),
    ))

  it("CallSpecific against a Cancelled ticket yields AlreadyCancelled (terminal guard)", async () =>
    runScenario(
      Effect.gen(function* () {
        const h = handle("ヤマダ タロウ", "1234")
        const t1 = yield* IssueTicket({ handle: h, freeText: null })
        yield* CancelTicket(t1.id, "customer", "x", h)
        const r = yield* eitherEffect(CallSpecific(t1.id))
        expect(r.ok).toBe(false)
        if (!r.ok) expect((r.error as { _tag: string })._tag).toBe("AlreadyCancelled")
      }),
    ))

  it("CallSpecific on a non-existent ticket yields TicketNotFound", async () =>
    runScenario(
      Effect.gen(function* () {
        const r = yield* eitherEffect(CallSpecific("tkt_00000000000000000000000000" as never))
        expect(r.ok).toBe(false)
        if (!r.ok) expect((r.error as { _tag: string })._tag).toBe("TicketNotFound")
      }),
    ))

  it("MoveToOverdue transitions Called → Overdue (ADR-0072)", async () =>
    runScenario(
      Effect.gen(function* () {
        const t1 = yield* IssueTicket({
          handle: handle("ヤマダ タロウ", "1234"),
          freeText: null,
        })
        yield* CallNext()
        const overdue = yield* MoveToOverdue(t1.id)
        expect(overdue.state).toBe("Overdue")
        if (overdue.state === "Overdue") {
          expect(overdue.nudgeCount).toBe(0)
          expect(overdue.lastNudgedAt).toBeNull()
        }
      }),
    ))

  it("MoveToOverdue on a Waiting ticket yields InvalidStateTransition", async () =>
    runScenario(
      Effect.gen(function* () {
        const t1 = yield* IssueTicket({
          handle: handle("ヤマダ タロウ", "1234"),
          freeText: null,
        })
        const r = yield* eitherEffect(MoveToOverdue(t1.id))
        expect(r.ok).toBe(false)
        if (!r.ok) expect((r.error as { _tag: string })._tag).toBe("InvalidStateTransition")
      }),
    ))

  it("MoveToOverdue on a Cancelled ticket yields AlreadyCancelled", async () =>
    runScenario(
      Effect.gen(function* () {
        const h = handle("ヤマダ タロウ", "1234")
        const t1 = yield* IssueTicket({ handle: h, freeText: null })
        yield* CancelTicket(t1.id, "customer", "x", h)
        const r = yield* eitherEffect(MoveToOverdue(t1.id))
        expect(r.ok).toBe(false)
        if (!r.ok) expect((r.error as { _tag: string })._tag).toBe("AlreadyCancelled")
      }),
    ))

  it("MoveToOverdue on a non-existent ticket yields TicketNotFound", async () =>
    runScenario(
      Effect.gen(function* () {
        const r = yield* eitherEffect(MoveToOverdue("tkt_00000000000000000000000000" as never))
        expect(r.ok).toBe(false)
        if (!r.ok) expect((r.error as { _tag: string })._tag).toBe("TicketNotFound")
      }),
    ))

  it("Nudge from Overdue increments nudgeCount", async () =>
    runScenario(
      Effect.gen(function* () {
        const t1 = yield* IssueTicket({
          handle: handle("ヤマダ タロウ", "1234"),
          freeText: null,
        })
        yield* CallNext()
        yield* MoveToOverdue(t1.id)
        const nudged = yield* Nudge(t1.id, "ws")
        expect(nudged.state).toBe("Overdue")
        if (nudged.state === "Overdue") expect(nudged.nudgeCount).toBe(1)
      }),
    ))

  it("Nudge on a non-Overdue ticket yields InvalidStateTransition", async () =>
    runScenario(
      Effect.gen(function* () {
        const t1 = yield* IssueTicket({
          handle: handle("ヤマダ タロウ", "1234"),
          freeText: null,
        })
        yield* CallNext()
        const r = yield* eitherEffect(Nudge(t1.id, "ws"))
        expect(r.ok).toBe(false)
        if (!r.ok) expect((r.error as { _tag: string })._tag).toBe("InvalidStateTransition")
      }),
    ))

  it("MarkServed accepts an Overdue ticket as source (late-arrival recovery)", async () =>
    runScenario(
      Effect.gen(function* () {
        const t1 = yield* IssueTicket({
          handle: handle("ヤマダ タロウ", "1234"),
          freeText: null,
        })
        yield* CallNext()
        yield* MoveToOverdue(t1.id)
        const served = yield* MarkServed(t1.id)
        expect(served.state).toBe("Served")
      }),
    ))

  it("MarkServed from Overdue drops overdueAt / lastNudgedAt / nudgeCount (no phantom fields)", async () =>
    // Regression pin for ADR-0071 projection type leak: after Nudge runs
    // (so the source ticket has lastNudgedAt + non-zero nudgeCount) the
    // resulting Served ticket MUST NOT carry Overdue-only fields.
    runScenario(
      Effect.gen(function* () {
        const t1 = yield* IssueTicket({
          handle: handle("ヤマダ タロウ", "1234"),
          freeText: null,
        })
        yield* CallNext()
        yield* MoveToOverdue(t1.id)
        yield* Nudge(t1.id, "ws")
        const served = (yield* MarkServed(t1.id)) as Record<string, unknown>
        expect(served.state).toBe("Served")
        expect("overdueAt" in served).toBe(false)
        expect("lastNudgedAt" in served).toBe(false)
        expect("nudgeCount" in served).toBe(false)
      }),
    ))

  it("MarkNoShow accepts an Overdue ticket as source (system-fired alarm terminal)", async () =>
    runScenario(
      Effect.gen(function* () {
        const t1 = yield* IssueTicket({
          handle: handle("ヤマダ タロウ", "1234"),
          freeText: null,
        })
        yield* CallNext()
        yield* MoveToOverdue(t1.id)
        const noShow = yield* MarkNoShow(t1.id, "system")
        expect(noShow.state).toBe("NoShow")
      }),
    ))

  it("LapseAppointment cancels a Waiting reservation past appointmentAt (ADR-0075)", async () =>
    runScenario(
      Effect.gen(function* () {
        const h = handle("ヨヤク タロウ", "5678")
        const t1 = yield* IssueTicket({
          handle: h,
          freeText: null,
          lane: "reservation",
          appointmentAt: Temporal.Instant.from("2020-01-01T00:00:00Z"),
        })
        const lapsed = yield* LapseAppointment(t1.id)
        expect(lapsed.state).toBe("Cancelled")
        if (lapsed.state === "Cancelled") {
          expect(lapsed.reason).toBe("appointment_lapsed")
        }
      }),
    ))

  it("LapseAppointment on a walk-in ticket yields LaneMismatch", async () =>
    runScenario(
      Effect.gen(function* () {
        const t1 = yield* IssueTicket({
          handle: handle("ヤマダ タロウ", "1234"),
          freeText: null,
        })
        const r = yield* eitherEffect(LapseAppointment(t1.id))
        expect(r.ok).toBe(false)
        if (!r.ok) expect((r.error as { _tag: string })._tag).toBe("LaneMismatch")
      }),
    ))

  it("CallBatch atomically calls every member, sharing a batchId", async () =>
    runScenario(
      Effect.gen(function* () {
        const a = yield* IssueTicket({ handle: handle("ヤマダ タロウ", "1234"), freeText: null })
        const b = yield* IssueTicket({ handle: handle("サトウ ハナコ", "5678"), freeText: null })
        const out = yield* CallBatch([a.id, b.id])
        expect(out).toHaveLength(2)
        expect(out.every((t) => t.state === "Called")).toBe(true)
      }),
    ))

  it("CallBatch on a Cancelled member rolls the entire batch (atomicity)", async () =>
    runScenario(
      Effect.gen(function* () {
        const h = handle("ヤマダ タロウ", "1234")
        const a = yield* IssueTicket({ handle: h, freeText: null })
        const b = yield* IssueTicket({ handle: handle("サトウ ハナコ", "5678"), freeText: null })
        yield* CancelTicket(b.id, "customer", "x", handle("サトウ ハナコ", "5678"))
        const r = yield* eitherEffect(CallBatch([a.id, b.id]))
        expect(r.ok).toBe(false)
        if (!r.ok) expect((r.error as { _tag: string })._tag).toBe("AlreadyCancelled")
      }),
    ))

  it("CallBatch with a non-Waiting member fails with InvalidStateTransition", async () =>
    runScenario(
      Effect.gen(function* () {
        const a = yield* IssueTicket({ handle: handle("ヤマダ タロウ", "1234"), freeText: null })
        const b = yield* IssueTicket({ handle: handle("サトウ ハナコ", "5678"), freeText: null })
        yield* CallNext()
        const r = yield* eitherEffect(CallBatch([a.id, b.id]))
        expect(r.ok).toBe(false)
        if (!r.ok) expect((r.error as { _tag: string })._tag).toBe("InvalidStateTransition")
      }),
    ))

  it("CallBatch on a non-existent ticket yields TicketNotFound", async () =>
    runScenario(
      Effect.gen(function* () {
        const r = yield* eitherEffect(CallBatch(["tkt_00000000000000000000000000" as never]))
        expect(r.ok).toBe(false)
        if (!r.ok) expect((r.error as { _tag: string })._tag).toBe("TicketNotFound")
      }),
    ))

  it("Reorder moves a Waiting ticket to lane head (afterTicketId = null)", async () =>
    runScenario(
      Effect.gen(function* () {
        const a = yield* IssueTicket({ handle: handle("ヤマダ タロウ", "1234"), freeText: null })
        const b = yield* IssueTicket({ handle: handle("サトウ ハナコ", "5678"), freeText: null })
        const reordered = yield* Reorder(b.id, null)
        expect(reordered.state).toBe("Waiting")
        // a was originally first; b moves ahead of it.
        expect(reordered.id).toBe(b.id)
        expect(a.id).not.toBe(reordered.id)
      }),
    ))

  it("Reorder accepts an after-ticket in the same lane", async () =>
    runScenario(
      Effect.gen(function* () {
        const a = yield* IssueTicket({ handle: handle("ヤマダ タロウ", "1234"), freeText: null })
        const b = yield* IssueTicket({ handle: handle("サトウ ハナコ", "5678"), freeText: null })
        const c = yield* IssueTicket({ handle: handle("タナカ ジロウ", "9999"), freeText: null })
        const out = yield* Reorder(c.id, a.id)
        expect(out.state).toBe("Waiting")
        expect(b.id).not.toBe(out.id)
      }),
    ))

  it("Reorder against a Called ticket yields InvalidStateTransition", async () =>
    runScenario(
      Effect.gen(function* () {
        const t1 = yield* IssueTicket({ handle: handle("ヤマダ タロウ", "1234"), freeText: null })
        yield* CallNext()
        const r = yield* eitherEffect(Reorder(t1.id, null))
        expect(r.ok).toBe(false)
        if (!r.ok) expect((r.error as { _tag: string })._tag).toBe("InvalidStateTransition")
      }),
    ))

  it("Reorder against a terminal ticket yields the matching Already* error", async () =>
    runScenario(
      Effect.gen(function* () {
        const h = handle("ヤマダ タロウ", "1234")
        const t1 = yield* IssueTicket({ handle: h, freeText: null })
        yield* CancelTicket(t1.id, "customer", "x", h)
        const r = yield* eitherEffect(Reorder(t1.id, null))
        expect(r.ok).toBe(false)
        if (!r.ok) expect((r.error as { _tag: string })._tag).toBe("AlreadyCancelled")
      }),
    ))

  it("Reorder on a non-existent ticket yields TicketNotFound", async () =>
    runScenario(
      Effect.gen(function* () {
        const r = yield* eitherEffect(Reorder("tkt_00000000000000000000000000" as never, null))
        expect(r.ok).toBe(false)
        if (!r.ok) expect((r.error as { _tag: string })._tag).toBe("TicketNotFound")
      }),
    ))

  it("Reorder with an unknown afterTicketId yields TicketNotFound", async () =>
    runScenario(
      Effect.gen(function* () {
        const t1 = yield* IssueTicket({ handle: handle("ヤマダ タロウ", "1234"), freeText: null })
        const r = yield* eitherEffect(Reorder(t1.id, "tkt_00000000000000000000000099" as never))
        expect(r.ok).toBe(false)
        if (!r.ok) expect((r.error as { _tag: string })._tag).toBe("TicketNotFound")
      }),
    ))

  it("Reorder against a peer in a different lane yields LaneMismatch", async () =>
    runScenario(
      Effect.gen(function* () {
        // a lands in walkIn (default), b lands in priority. Reordering
        // a after b crosses lanes — ADR-0065 forbids it.
        const a = yield* IssueTicket({ handle: handle("ヤマダ タロウ", "1234"), freeText: null })
        const b = yield* IssueTicket({
          handle: handle("サトウ ハナコ", "5678"),
          freeText: null,
          lane: "priority",
        })
        const r = yield* eitherEffect(Reorder(a.id, b.id))
        expect(r.ok).toBe(false)
        if (!r.ok) expect((r.error as { _tag: string })._tag).toBe("LaneMismatch")
      }),
    ))

  /**
   * The CallNext use case has a defensive `catchTag("AggregateNotFound")`
   * that maps a head/load race to QueueEmpty. Single-writer InMemory
   * never exhibits this race, so we wire a stub repo whose listAll
   * surfaces a Waiting projection but whose `load` always reports
   * AggregateNotFound. This pins the catchTag callback under test.
   */
  it("CallNext gracefully recovers when load() races against head() (catchTag → QueueEmpty)", async () => {
    const ghost = applyIssue({
      id: newTicketId(),
      seq: 1,
      lane: "walkIn",
      displaySeq: 1,
      nameKana: handle("ヤマダ タロウ", "1234").nameKana,
      phoneLast4: handle("ヤマダ タロウ", "1234").phoneLast4,
      freeText: null,
      appointmentAt: null,
      at: Temporal.Instant.from("2026-05-08T09:00:00Z"),
      eventId: newTicketEventId(),
    })
    const stubRepoLayer = Layer.succeed(
      TicketRepository,
      TicketRepository.of({
        listAll: () => Effect.succeed([ghost.ticket]),
        load: () => Effect.fail(new AggregateNotFoundError({})),
        save: () => Effect.void,
        issue: () => Effect.void,
        saveBatch: () => Effect.void,
        nextSeq: () => Effect.succeed(1),
        findActiveByHandle: () => Effect.succeed(null),
      }),
    )
    const layer = Layer.mergeAll(
      SystemClockLive,
      DeterministicIdGeneratorLive,
      stubRepoLayer,
      SilentLoggerLive,
    )
    const result = await Effect.runPromise(
      Effect.matchEffect(CallNext(), {
        onSuccess: (value) => Effect.succeed({ ok: true as const, value }),
        onFailure: (error) => Effect.succeed({ ok: false as const, error }),
      }).pipe(Effect.provide(layer)),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error._tag).toBe("QueueEmpty")
  })

  it("CallNext with explicit lane uses the head of that lane (ADR-0062)", async () =>
    runScenario(
      Effect.gen(function* () {
        // Walk-in first, reservation eligible — but explicit "walkIn"
        // pins the call to the walk-in lane head, bypassing EDF.
        const wkr = yield* IssueTicket({
          handle: handle("ヤマダ タロウ", "1234"),
          freeText: null,
        })
        yield* IssueTicket({
          handle: handle("スズキ ジロウ", "5678"),
          freeText: null,
          lane: "reservation",
          appointmentAt: Temporal.Now.instant().add({ minutes: 2 }),
        })
        const called = yield* CallNext("walkIn")
        expect(called.id).toBe(wkr.id)
      }),
    ))

  it("CallNext promotes an eligible reservation past the static priority chain (ADR-0067 EDF)", async () =>
    runScenario(
      Effect.gen(function* () {
        // Walk-in lands first; then a reservation whose appointmentAt
        // is within the 5-min EDF grace window. CallNext (no lane)
        // must pick the reservation, not the walk-in head.
        const wkr = yield* IssueTicket({
          handle: handle("ヤマダ タロウ", "1234"),
          freeText: null,
        })
        const apptAt = Temporal.Now.instant().add({ minutes: 2 })
        const rsv = yield* IssueTicket({
          handle: handle("スズキ ジロウ", "5678"),
          freeText: null,
          lane: "reservation",
          appointmentAt: apptAt,
        })
        const called = yield* CallNext()
        expect(called.id).toBe(rsv.id)
        expect(called.id).not.toBe(wkr.id)
      }),
    ))

  it("CallNext falls back to walkIn when the reservation is outside the EDF grace window", async () =>
    runScenario(
      Effect.gen(function* () {
        const wkr = yield* IssueTicket({
          handle: handle("ヤマダ タロウ", "1234"),
          freeText: null,
        })
        // 30min in the future — well outside the 5min grace.
        const apptAt = Temporal.Now.instant().add({ minutes: 30 })
        yield* IssueTicket({
          handle: handle("スズキ ジロウ", "5678"),
          freeText: null,
          lane: "reservation",
          appointmentAt: apptAt,
        })
        const called = yield* CallNext()
        expect(called.id).toBe(wkr.id)
      }),
    ))

  it("CheckIn on a reservation within the 10-min window succeeds", async () =>
    runScenario(
      Effect.gen(function* () {
        // Issue a reservation with appointmentAt = now + 5min so the
        // CheckIn window (`now ≥ apptAt - 10min`) is open.
        const apptAt = Temporal.Now.instant().add({ minutes: 5 })
        const t1 = yield* IssueTicket({
          handle: handle("ヤマダ タロウ", "1234"),
          freeText: null,
          lane: "reservation",
          appointmentAt: apptAt,
        })
        yield* CheckIn(t1.id)
      }),
    ))

  it("CheckIn before the 10-min window yields CheckInTooEarly", async () =>
    runScenario(
      Effect.gen(function* () {
        // appointmentAt = now + 30min → window opens at now + 20min
        const apptAt = Temporal.Now.instant().add({ minutes: 30 })
        const t1 = yield* IssueTicket({
          handle: handle("ヤマダ タロウ", "1234"),
          freeText: null,
          lane: "reservation",
          appointmentAt: apptAt,
        })
        const r = yield* eitherEffect(CheckIn(t1.id))
        expect(r.ok).toBe(false)
        if (!r.ok) {
          const err = r.error as { _tag: string }
          expect(err._tag).toBe("CheckInTooEarly")
        }
      }),
    ))

  it("CheckIn on a walk-in ticket yields AppointmentRequired (no reservation)", async () =>
    runScenario(
      Effect.gen(function* () {
        const t1 = yield* IssueTicket({
          handle: handle("ヤマダ タロウ", "1234"),
          freeText: null,
        })
        const r = yield* eitherEffect(CheckIn(t1.id))
        expect(r.ok).toBe(false)
        if (!r.ok) {
          const err = r.error as { _tag: string }
          expect(err._tag).toBe("AppointmentRequiredForReservationLane")
        }
      }),
    ))

  it("CheckIn on a Called ticket yields InvalidStateTransition", async () =>
    runScenario(
      Effect.gen(function* () {
        const apptAt = Temporal.Now.instant().add({ minutes: 5 })
        const t1 = yield* IssueTicket({
          handle: handle("ヤマダ タロウ", "1234"),
          freeText: null,
          lane: "reservation",
          appointmentAt: apptAt,
        })
        yield* CallNext()
        const r = yield* eitherEffect(CheckIn(t1.id))
        expect(r.ok).toBe(false)
        if (!r.ok) {
          const err = r.error as { _tag: string }
          expect(err._tag).toBe("InvalidStateTransition")
        }
      }),
    ))

  it("CheckIn on an unknown ticket yields TicketNotFound", async () =>
    runScenario(
      Effect.gen(function* () {
        const r = yield* eitherEffect(CheckIn(newTicketId()))
        expect(r.ok).toBe(false)
        if (!r.ok) {
          const err = r.error as { _tag: string }
          expect(err._tag).toBe("TicketNotFound")
        }
      }),
    ))

  /* ------------------------------------------------------------------------ */
  /* ADR-0069 — idempotent IssueTicket (handle as active-set primary key)     */
  /* ------------------------------------------------------------------------ */

  it("ADR-0069: re-issue with same handle returns the existing active ticket", async () =>
    runScenario(
      Effect.gen(function* () {
        const h = handle("ヤマダ タロウ", "1234")
        const t1 = yield* IssueTicket({ handle: h, freeText: null })
        const t2 = yield* IssueTicket({ handle: h, freeText: null })
        expect(t2.id).toBe(t1.id)
        expect(t2.seq).toBe(t1.seq)
        expect(t2.state).toBe("Waiting")
      }),
    ))

  it("ADR-0069: re-issue ignores caller-supplied lane / appointmentAt", async () =>
    runScenario(
      Effect.gen(function* () {
        const h = handle("ヤマダ タロウ", "1234")
        const t1 = yield* IssueTicket({ handle: h, freeText: null, lane: "walkIn" })
        // Second issue tries to upgrade lane → priority + supply appointmentAt;
        // both fields stay at the first issue's values.
        const t2 = yield* IssueTicket({
          handle: h,
          freeText: null,
          lane: "priority",
          appointmentAt: Temporal.Instant.from("2026-05-15T10:30:00Z"),
        })
        expect(t2.id).toBe(t1.id)
        expect(t2.lane).toBe("walkIn")
        expect(t2.appointmentAt).toBeNull()
      }),
    ))

  it("ADR-0069: terminal Served releases handle — re-issue mints a fresh ticket", async () =>
    runScenario(
      Effect.gen(function* () {
        const h = handle("ヤマダ タロウ", "1234")
        const t1 = yield* IssueTicket({ handle: h, freeText: null })
        yield* CallNext()
        yield* MarkServed(t1.id)
        const t2 = yield* IssueTicket({ handle: h, freeText: null })
        expect(t2.id).not.toBe(t1.id)
        expect(t2.state).toBe("Waiting")
      }),
    ))

  it("ADR-0069: Called ticket still holds the handle — re-issue merges", async () =>
    runScenario(
      Effect.gen(function* () {
        const h = handle("ヤマダ タロウ", "1234")
        const t1 = yield* IssueTicket({ handle: h, freeText: null })
        yield* CallNext()
        const t2 = yield* IssueTicket({ handle: h, freeText: null })
        expect(t2.id).toBe(t1.id)
        expect(t2.state).toBe("Called")
      }),
    ))

  /* ------------------------------------------------------------------------ */
  /* ADR-0070 — RescheduleTicket (atomic appointmentAt swap)                 */
  /* ------------------------------------------------------------------------ */

  it("RescheduleTicket moves appointmentAt while preserving ticketId / seq", async () =>
    runScenario(
      Effect.gen(function* () {
        const tz = Schema.decodeUnknownSync(BusinessTimeZoneSchema)("Asia/Tokyo")
        const apptA = Temporal.Now.instant().add({ hours: 2 })
        const apptB = Temporal.Now.instant().add({ hours: 4 })
        const t1 = yield* IssueTicket({
          handle: handle("ヤマダ タロウ", "1234"),
          freeText: null,
          lane: "reservation",
          appointmentAt: apptA,
        })
        const t2 = yield* RescheduleTicket({
          ticketId: t1.id,
          newAppointmentAt: apptB,
          granularity: 30,
          tz,
          capacity: 2,
          actor: "customer",
          handle: handle("ヤマダ タロウ", "1234"),
        })
        expect(t2.id).toBe(t1.id)
        expect(t2.seq).toBe(t1.seq)
        expect(t2.appointmentAt).not.toBeNull()
        if (t2.appointmentAt !== null) {
          expect(Temporal.Instant.compare(t2.appointmentAt, apptB)).toBe(0)
        }
      }),
    ))

  it("RescheduleTicket to the same slot is a no-op success", async () =>
    runScenario(
      Effect.gen(function* () {
        const tz = Schema.decodeUnknownSync(BusinessTimeZoneSchema)("Asia/Tokyo")
        const apptAt = Temporal.Now.instant().add({ hours: 2 })
        const t1 = yield* IssueTicket({
          handle: handle("ヤマダ タロウ", "1234"),
          freeText: null,
          lane: "reservation",
          appointmentAt: apptAt,
        })
        const t2 = yield* RescheduleTicket({
          ticketId: t1.id,
          newAppointmentAt: apptAt,
          granularity: 30,
          tz,
          capacity: 2,
          actor: "customer",
          handle: handle("ヤマダ タロウ", "1234"),
        })
        expect(t2.id).toBe(t1.id)
        if (t2.appointmentAt !== null) {
          expect(Temporal.Instant.compare(t2.appointmentAt, apptAt)).toBe(0)
        }
      }),
    ))

  it("RescheduleTicket on a walk-in ticket yields LaneMismatch", async () =>
    runScenario(
      Effect.gen(function* () {
        const tz = Schema.decodeUnknownSync(BusinessTimeZoneSchema)("Asia/Tokyo")
        const apptB = Temporal.Now.instant().add({ hours: 2 })
        const t1 = yield* IssueTicket({
          handle: handle("ヤマダ タロウ", "1234"),
          freeText: null,
        })
        const r = yield* eitherEffect(
          RescheduleTicket({
            ticketId: t1.id,
            newAppointmentAt: apptB,
            granularity: 30,
            tz,
            capacity: 2,
            actor: "customer",
            handle: handle("ヤマダ タロウ", "1234"),
          }),
        )
        expect(r.ok).toBe(false)
        if (!r.ok) {
          const err = r.error as { _tag: string }
          expect(err._tag).toBe("LaneMismatch")
        }
      }),
    ))

  it("RescheduleTicket to a past time yields SlotInPast", async () =>
    runScenario(
      Effect.gen(function* () {
        const tz = Schema.decodeUnknownSync(BusinessTimeZoneSchema)("Asia/Tokyo")
        const apptA = Temporal.Now.instant().add({ hours: 2 })
        const apptPast = Temporal.Now.instant().subtract({ hours: 2 })
        const t1 = yield* IssueTicket({
          handle: handle("ヤマダ タロウ", "1234"),
          freeText: null,
          lane: "reservation",
          appointmentAt: apptA,
        })
        const r = yield* eitherEffect(
          RescheduleTicket({
            ticketId: t1.id,
            newAppointmentAt: apptPast,
            granularity: 30,
            tz,
            capacity: 2,
            actor: "customer",
            handle: handle("ヤマダ タロウ", "1234"),
          }),
        )
        expect(r.ok).toBe(false)
        if (!r.ok) {
          const err = r.error as { _tag: string }
          expect(err._tag).toBe("SlotInPast")
        }
      }),
    ))

  it("RescheduleTicket onto a full slot (excluding self) yields SlotFull", async () =>
    runScenario(
      Effect.gen(function* () {
        const tz = Schema.decodeUnknownSync(BusinessTimeZoneSchema)("Asia/Tokyo")
        // Bucket-align both apptA and apptB to 30-minute boundaries
        // so `intervalOf(slot, tz).startAt` matches the stored
        // `appointmentAt` exactly. Real /issue path always feeds
        // bucket-aligned instants (the slot picker hands back
        // `bucketOf` outputs), so this mirrors production semantics.
        const nowLocal = Temporal.Now.zonedDateTimeISO(tz)
        const baseLocal = nowLocal
          .add({ hours: 2 })
          .with({ minute: 0, second: 0, millisecond: 0, microsecond: 0, nanosecond: 0 })
        const apptA = baseLocal.toInstant()
        const apptB = baseLocal.add({ minutes: 30 }).toInstant()
        // Fill apptB to capacity 1 with one ticket from a different handle.
        yield* IssueTicket({
          handle: handle("サトウ ハナコ", "5678"),
          freeText: null,
          lane: "reservation",
          appointmentAt: apptB,
        })
        const t1 = yield* IssueTicket({
          handle: handle("ヤマダ タロウ", "1234"),
          freeText: null,
          lane: "reservation",
          appointmentAt: apptA,
        })
        // Capacity 1 + apptB already occupied by サトウ → ヤマダ
        // reschedule to apptB rejected (occupancy_excluding_self=1).
        const r = yield* eitherEffect(
          RescheduleTicket({
            ticketId: t1.id,
            newAppointmentAt: apptB,
            granularity: 30,
            tz,
            capacity: 1,
            actor: "customer",
            handle: handle("ヤマダ タロウ", "1234"),
          }),
        )
        expect(r.ok).toBe(false)
        if (!r.ok) {
          const err = r.error as { _tag: string }
          expect(err._tag).toBe("SlotFull")
        }
      }),
    ))

  it("RescheduleTicket with wrong handle yields PhoneMismatch", async () =>
    runScenario(
      Effect.gen(function* () {
        const tz = Schema.decodeUnknownSync(BusinessTimeZoneSchema)("Asia/Tokyo")
        const apptA = Temporal.Now.instant().add({ hours: 2 })
        const apptB = Temporal.Now.instant().add({ hours: 4 })
        const t1 = yield* IssueTicket({
          handle: handle("ヤマダ タロウ", "1234"),
          freeText: null,
          lane: "reservation",
          appointmentAt: apptA,
        })
        const r = yield* eitherEffect(
          RescheduleTicket({
            ticketId: t1.id,
            newAppointmentAt: apptB,
            granularity: 30,
            tz,
            capacity: 2,
            actor: "customer",
            handle: handle("ヤマダ タロウ", "9999"),
          }),
        )
        expect(r.ok).toBe(false)
        if (!r.ok) {
          const err = r.error as { _tag: string }
          expect(err._tag).toBe("PhoneMismatch")
        }
      }),
    ))

  it("RescheduleTicket via staff path (no handle) succeeds from Called", async () =>
    runScenario(
      Effect.gen(function* () {
        const tz = Schema.decodeUnknownSync(BusinessTimeZoneSchema)("Asia/Tokyo")
        const apptA = Temporal.Now.instant().add({ hours: 2 })
        const apptB = Temporal.Now.instant().add({ hours: 4 })
        const t1 = yield* IssueTicket({
          handle: handle("ヤマダ タロウ", "1234"),
          freeText: null,
          lane: "reservation",
          appointmentAt: apptA,
        })
        yield* CallNext()
        const t2 = yield* RescheduleTicket({
          ticketId: t1.id,
          newAppointmentAt: apptB,
          granularity: 30,
          tz,
          capacity: 2,
          actor: "staff",
        })
        expect(t2.id).toBe(t1.id)
        expect(t2.state).toBe("Called")
      }),
    ))

  it("RescheduleTicket via staff path succeeds from Overdue (ADR-0072)", async () =>
    runScenario(
      Effect.gen(function* () {
        const tz = Schema.decodeUnknownSync(BusinessTimeZoneSchema)("Asia/Tokyo")
        const apptA = Temporal.Now.instant().add({ hours: 2 })
        const apptB = Temporal.Now.instant().add({ hours: 4 })
        const t1 = yield* IssueTicket({
          handle: handle("ヤマダ タロウ", "1234"),
          freeText: null,
          lane: "reservation",
          appointmentAt: apptA,
        })
        yield* CallNext()
        yield* MoveToOverdue(t1.id)
        const t2 = yield* RescheduleTicket({
          ticketId: t1.id,
          newAppointmentAt: apptB,
          granularity: 30,
          tz,
          capacity: 2,
          actor: "staff",
        })
        expect(t2.id).toBe(t1.id)
        expect(t2.state).toBe("Overdue")
      }),
    ))

  it("RescheduleTicket on a Served ticket yields InvalidStateTransition", async () =>
    runScenario(
      Effect.gen(function* () {
        const tz = Schema.decodeUnknownSync(BusinessTimeZoneSchema)("Asia/Tokyo")
        const apptA = Temporal.Now.instant().add({ hours: 2 })
        const apptB = Temporal.Now.instant().add({ hours: 4 })
        const t1 = yield* IssueTicket({
          handle: handle("ヤマダ タロウ", "1234"),
          freeText: null,
          lane: "reservation",
          appointmentAt: apptA,
        })
        yield* CallNext()
        yield* MarkServed(t1.id)
        const r = yield* eitherEffect(
          RescheduleTicket({
            ticketId: t1.id,
            newAppointmentAt: apptB,
            granularity: 30,
            tz,
            capacity: 2,
            actor: "staff",
          }),
        )
        expect(r.ok).toBe(false)
        if (!r.ok) {
          const err = r.error as { _tag: string }
          expect(err._tag).toBe("InvalidStateTransition")
        }
      }),
    ))

  it("RescheduleTicket on a Cancelled ticket yields InvalidStateTransition", async () =>
    runScenario(
      Effect.gen(function* () {
        const tz = Schema.decodeUnknownSync(BusinessTimeZoneSchema)("Asia/Tokyo")
        const apptA = Temporal.Now.instant().add({ hours: 2 })
        const apptB = Temporal.Now.instant().add({ hours: 4 })
        const h = handle("ヤマダ タロウ", "1234")
        const t1 = yield* IssueTicket({
          handle: h,
          freeText: null,
          lane: "reservation",
          appointmentAt: apptA,
        })
        yield* CancelTicket(t1.id, "customer", "test-cancel", h)
        const r = yield* eitherEffect(
          RescheduleTicket({
            ticketId: t1.id,
            newAppointmentAt: apptB,
            granularity: 30,
            tz,
            capacity: 2,
            actor: "staff",
          }),
        )
        expect(r.ok).toBe(false)
        if (!r.ok) {
          const err = r.error as { _tag: string }
          expect(err._tag).toBe("InvalidStateTransition")
        }
      }),
    ))

  it("RescheduleTicket on a NoShow ticket yields InvalidStateTransition", async () =>
    runScenario(
      Effect.gen(function* () {
        const tz = Schema.decodeUnknownSync(BusinessTimeZoneSchema)("Asia/Tokyo")
        const apptA = Temporal.Now.instant().add({ hours: 2 })
        const apptB = Temporal.Now.instant().add({ hours: 4 })
        const t1 = yield* IssueTicket({
          handle: handle("ヤマダ タロウ", "1234"),
          freeText: null,
          lane: "reservation",
          appointmentAt: apptA,
        })
        yield* CallNext()
        yield* MarkNoShow(t1.id, "staff")
        const r = yield* eitherEffect(
          RescheduleTicket({
            ticketId: t1.id,
            newAppointmentAt: apptB,
            granularity: 30,
            tz,
            capacity: 2,
            actor: "staff",
          }),
        )
        expect(r.ok).toBe(false)
        if (!r.ok) {
          const err = r.error as { _tag: string }
          expect(err._tag).toBe("InvalidStateTransition")
        }
      }),
    ))
})
