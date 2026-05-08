import { Effect, Layer, Result, Schema } from "effect"
import { describe, expect, it } from "vitest"
import type { Clock } from "../../../../src/application/ports/Clock.js"
import type { TicketRepository } from "../../../../src/application/ports/EventSourcedRepository.js"
import type { Logger } from "../../../../src/application/ports/Logger.js"
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

const env = Layer.mergeAll(
  SystemClockLive,
  DeterministicIdGeneratorLive,
  InMemoryTicketRepositoryLive,
  SilentLoggerLive,
)

const run = <A, E>(
  eff: Effect.Effect<A, E, Clock | typeof Logger.Service | typeof TicketRepository.Service | never>,
) => Effect.runPromise(eff.pipe(Effect.provide(env)) as unknown as Effect.Effect<A, E, never>)

describe("queue lifecycle round-trip", () => {
  it("issue → callNext → markServed", async () => {
    const t1 = await run(IssueTicket({ handle: handle("ヤマダ タロウ", "1234"), freeText: null }))
    expect(t1.state).toBe("Waiting")
    const called = await run(CallNext())
    expect(called.state).toBe("Called")
    const served = await run(MarkServed(t1.id))
    expect(served.state).toBe("Served")
  })

  it("issue → callNext → markNoShow (system actor)", async () => {
    const t1 = await run(IssueTicket({ handle: handle("ヤマダ タロウ", "1234"), freeText: null }))
    await run(CallNext())
    const ns = await run(MarkNoShow(t1.id, "system"))
    expect(ns.state).toBe("NoShow")
  })

  it("issue → cancel by customer (handle verified)", async () => {
    const h = handle("ヤマダ タロウ", "1234")
    const t1 = await run(IssueTicket({ handle: h, freeText: null }))
    const cancelled = await run(CancelTicket(t1.id, "customer", "changed plans", h))
    expect(cancelled.state).toBe("Cancelled")
  })

  it("cancel with mismatched handle yields PhoneMismatch", async () => {
    const t1 = await run(IssueTicket({ handle: handle("ヤマダ タロウ", "1234"), freeText: null }))
    const wrong = handle("サトウ ジロウ", "1234")
    const r = await Effect.runPromise(
      Effect.either(CancelTicket(t1.id, "customer", "x", wrong).pipe(Effect.provide(env))),
    )
    expect(Result.isFailure(r) || r._tag === "Left").toBe(true)
    if ("left" in r) {
      const err = r.left as { _tag: string }
      expect(err._tag).toBe("PhoneMismatch")
    }
  })

  it("CallNext on empty queue yields QueueEmpty", async () => {
    const r = await Effect.runPromise(Effect.either(CallNext().pipe(Effect.provide(env))))
    expect("left" in r).toBe(true)
    if ("left" in r) {
      const err = r.left as { _tag: string }
      expect(err._tag).toBe("QueueEmpty")
    }
  })

  it("MarkServed against a Waiting ticket yields InvalidStateTransition", async () => {
    const t1 = await run(IssueTicket({ handle: handle("ヤマダ タロウ", "1234"), freeText: null }))
    const r = await Effect.runPromise(Effect.either(MarkServed(t1.id).pipe(Effect.provide(env))))
    expect("left" in r).toBe(true)
    if ("left" in r) {
      const err = r.left as { _tag: string }
      expect(err._tag).toBe("InvalidStateTransition")
    }
  })

  it("MarkServed on a non-existent ticket yields TicketNotFound", async () => {
    const r = await Effect.runPromise(
      Effect.either(
        MarkServed("tkt_00000000000000000000000000" as never).pipe(Effect.provide(env)),
      ),
    )
    expect("left" in r).toBe(true)
    if ("left" in r) {
      const err = r.left as { _tag: string }
      expect(err._tag).toBe("TicketNotFound")
    }
  })
})
