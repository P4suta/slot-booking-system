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

const env = Layer.mergeAll(
  SystemClockLive,
  DeterministicIdGeneratorLive,
  InMemoryTicketRepositoryLive,
  SilentLoggerLive,
)

type Outcome<A, E> = { ok: true; value: A } | { ok: false; error: E }

/**
 * `Effect.either` is not exported in Effect 4.0.0-beta.64, so we
 * reach the same shape via `Effect.matchEffect` — the success / failure
 * branches both succeed with a tagged record. The generic `R` is
 * provided through `env` so the caller passes plain
 * `Effect<A, E, R>`-shaped use-case effects.
 */
const run = <A, E, R>(eff: Effect.Effect<A, E, R>): Promise<Outcome<A, E>> =>
  Effect.runPromise(
    Effect.matchEffect(eff, {
      onSuccess: (value) => Effect.succeed({ ok: true as const, value }),
      onFailure: (error) => Effect.succeed({ ok: false as const, error }),
    }).pipe(Effect.provide(env)) as unknown as Effect.Effect<Outcome<A, E>>,
  )

const expectOk = <A, E>(r: Outcome<A, E>): A => {
  if (!r.ok) throw new Error(`expected ok, got error ${JSON.stringify(r.error)}`)
  return r.value
}

describe("queue lifecycle round-trip", () => {
  it("issue → callNext → markServed", async () => {
    const t1 = expectOk(
      await run(IssueTicket({ handle: handle("ヤマダ タロウ", "1234"), freeText: null })),
    )
    expect(t1.state).toBe("Waiting")
    const called = expectOk(await run(CallNext()))
    expect(called.state).toBe("Called")
    const served = expectOk(await run(MarkServed(t1.id)))
    expect(served.state).toBe("Served")
  })

  it("issue → callNext → markNoShow (system actor)", async () => {
    const t1 = expectOk(
      await run(IssueTicket({ handle: handle("ヤマダ タロウ", "1234"), freeText: null })),
    )
    await run(CallNext())
    const ns = expectOk(await run(MarkNoShow(t1.id, "system")))
    expect(ns.state).toBe("NoShow")
  })

  it("issue → cancel by customer (handle verified)", async () => {
    const h = handle("ヤマダ タロウ", "1234")
    const t1 = expectOk(await run(IssueTicket({ handle: h, freeText: null })))
    const cancelled = expectOk(await run(CancelTicket(t1.id, "customer", "changed plans", h)))
    expect(cancelled.state).toBe("Cancelled")
  })

  it("cancel with mismatched handle yields PhoneMismatch", async () => {
    const t1 = expectOk(
      await run(IssueTicket({ handle: handle("ヤマダ タロウ", "1234"), freeText: null })),
    )
    const wrong = handle("サトウ ジロウ", "1234")
    const r = await run(CancelTicket(t1.id, "customer", "x", wrong))
    expect(r.ok).toBe(false)
    if (!r.ok) {
      const err = r.error as { _tag: string }
      expect(err._tag).toBe("PhoneMismatch")
    }
  })

  it("CallNext on empty queue yields QueueEmpty", async () => {
    const r = await run(CallNext())
    expect(r.ok).toBe(false)
    if (!r.ok) {
      const err = r.error as { _tag: string }
      expect(err._tag).toBe("QueueEmpty")
    }
  })

  it("MarkServed against a Waiting ticket yields InvalidStateTransition", async () => {
    const t1 = expectOk(
      await run(IssueTicket({ handle: handle("ヤマダ タロウ", "1234"), freeText: null })),
    )
    const r = await run(MarkServed(t1.id))
    expect(r.ok).toBe(false)
    if (!r.ok) {
      const err = r.error as { _tag: string }
      expect(err._tag).toBe("InvalidStateTransition")
    }
  })

  it("MarkServed on a non-existent ticket yields TicketNotFound", async () => {
    const r = await run(MarkServed("tkt_00000000000000000000000000" as never))
    expect(r.ok).toBe(false)
    if (!r.ok) {
      const err = r.error as { _tag: string }
      expect(err._tag).toBe("TicketNotFound")
    }
  })
})
