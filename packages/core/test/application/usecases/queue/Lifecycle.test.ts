import { Temporal } from "@js-temporal/polyfill"
import { Effect, Layer, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { TicketRepository } from "../../../../src/application/ports/EventSourcedRepository.js"
import {
  CallBatch,
  CallNext,
  CallSpecific,
  CancelTicket,
  IssueTicket,
  MarkNoShow,
  MarkServed,
  Recall,
  Reorder,
  StartServing,
} from "../../../../src/application/usecases/queue/index.js"
import { AggregateNotFoundError } from "../../../../src/domain/errors/Errors.js"
import { applyIssue } from "../../../../src/domain/queue/transitions.js"
import { newTicketEventId, newTicketId } from "../../../../src/domain/types/EntityId.js"
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

  it("StartServing transitions Called → Serving (ADR-0063)", async () =>
    runScenario(
      Effect.gen(function* () {
        const t1 = yield* IssueTicket({
          handle: handle("ヤマダ タロウ", "1234"),
          freeText: null,
        })
        yield* CallNext()
        const serving = yield* StartServing(t1.id)
        expect(serving.state).toBe("Serving")
      }),
    ))

  it("StartServing on a Waiting ticket yields InvalidStateTransition", async () =>
    runScenario(
      Effect.gen(function* () {
        const t1 = yield* IssueTicket({
          handle: handle("ヤマダ タロウ", "1234"),
          freeText: null,
        })
        const r = yield* eitherEffect(StartServing(t1.id))
        expect(r.ok).toBe(false)
        if (!r.ok) expect((r.error as { _tag: string })._tag).toBe("InvalidStateTransition")
      }),
    ))

  it("StartServing on a Cancelled ticket yields AlreadyCancelled", async () =>
    runScenario(
      Effect.gen(function* () {
        const h = handle("ヤマダ タロウ", "1234")
        const t1 = yield* IssueTicket({ handle: h, freeText: null })
        yield* CancelTicket(t1.id, "customer", "x", h)
        const r = yield* eitherEffect(StartServing(t1.id))
        expect(r.ok).toBe(false)
        if (!r.ok) expect((r.error as { _tag: string })._tag).toBe("AlreadyCancelled")
      }),
    ))

  it("StartServing on a non-existent ticket yields TicketNotFound", async () =>
    runScenario(
      Effect.gen(function* () {
        const r = yield* eitherEffect(StartServing("tkt_00000000000000000000000000" as never))
        expect(r.ok).toBe(false)
        if (!r.ok) expect((r.error as { _tag: string })._tag).toBe("TicketNotFound")
      }),
    ))

  it("MarkServed accepts a Serving ticket as source (ADR-0063 broadens)", async () =>
    runScenario(
      Effect.gen(function* () {
        const t1 = yield* IssueTicket({
          handle: handle("ヤマダ タロウ", "1234"),
          freeText: null,
        })
        yield* CallNext()
        yield* StartServing(t1.id)
        const served = yield* MarkServed(t1.id)
        expect(served.state).toBe("Served")
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
})
