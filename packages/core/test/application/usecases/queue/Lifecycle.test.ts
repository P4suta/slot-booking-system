import { Effect, Layer, Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  CallNext,
  CancelTicket,
  IssueTicket,
  MarkNoShow,
  MarkServed,
} from "../../../../src/application/usecases/queue/index.js"
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
})
