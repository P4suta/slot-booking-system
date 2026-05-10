import { Effect, Exit, Layer } from "effect"
import { describe, expect, it } from "vitest"
import { TicketRepository } from "../../../src/application/ports/EventSourcedRepository.js"
import {
  applyAndPersist,
  issueAndPersist,
  useCaseEnv,
} from "../../../src/application/usecases/_withUseCaseEnv.js"
import type { Called, Waiting } from "../../../src/domain/queue/Ticket.js"
import { applyCall, applyIssue, applyMarkServed } from "../../../src/domain/queue/transitions.js"
import type { NameKana } from "../../../src/domain/value-objects/NameKana.js"
import type { PhoneLast4 } from "../../../src/domain/value-objects/PhoneLast4.js"
import { SystemClockLive } from "../../../src/infrastructure/clock/SystemClockLive.js"
import { InMemoryTicketRepositoryLive } from "../../../src/infrastructure/eventsourced/InMemoryEventSourcedRepositoryLive.js"
import { DeterministicIdGeneratorLive } from "../../../src/infrastructure/id/DeterministicIdGeneratorLive.js"
import { makeSilentLogger } from "../../../src/infrastructure/logger/SilentLoggerLive.js"

const KANA = "ヤマダ タロウ" as unknown as NameKana
const PHONE = "1234" as unknown as PhoneLast4

/**
 * Each test runs its full scenario inside a single `Effect.gen` so
 * the in-memory `Ref<Map>` lives across the use-case + combinator
 * calls without an inter-run reset.
 */

describe("useCaseEnv", () => {
  it("aggregates Clock / IdGenerator / TicketRepository / Logger into one bind", async () => {
    const layer = Layer.mergeAll(
      SystemClockLive,
      DeterministicIdGeneratorLive,
      InMemoryTicketRepositoryLive,
      (await Effect.runPromise(makeSilentLogger())).layer,
    )
    const env = await Effect.runPromise(useCaseEnv.pipe(Effect.provide(layer)))
    expect(env.clock).toBeDefined()
    expect(env.idgen).toBeDefined()
    expect(env.repo).toBeDefined()
    expect(env.logger).toBeDefined()
  })
})

describe("issueAndPersist", () => {
  it("mints id+eventId+seq+at, persists via repo.issue, emits info log", async () => {
    const handle = await Effect.runPromise(makeSilentLogger())
    const layer = Layer.mergeAll(
      SystemClockLive,
      DeterministicIdGeneratorLive,
      InMemoryTicketRepositoryLive,
      handle.layer,
    )
    const program = Effect.gen(function* () {
      const ticket = yield* issueAndPersist({
        apply: (id, eventId, at, seq) =>
          applyIssue({
            id,
            seq,
            lane: "walkIn",
            displaySeq: seq,
            nameKana: KANA,
            phoneLast4: PHONE,
            freeText: null,
            appointmentAt: null,
            at,
            eventId,
          }),
        log: ({ id, seq }) => ({
          tag: "IssueTicket",
          code: "I_USECASE_ISSUE_TICKET",
          data: { ticketId: id, seq },
        }),
      })
      const repo = yield* TicketRepository
      const all = yield* repo.listAll()
      const entries = yield* handle.emitted
      return { ticket, all, entries }
    })

    const { ticket, all, entries } = await Effect.runPromise(
      program.pipe(Effect.provide(layer), Effect.orDie),
    )

    expect(ticket.state).toBe("Waiting")
    expect((ticket.id as string).startsWith("tkt_")).toBe(true)
    expect(ticket.seq).toBeGreaterThanOrEqual(1)
    expect(all.length).toBe(1)
    expect(all[0]?.id).toBe(ticket.id)
    expect(entries.some((e) => e.payload._tag === "IssueTicket")).toBe(true)
  })

  it("two consecutive issuances increment seq", async () => {
    const handle = await Effect.runPromise(makeSilentLogger())
    const layer = Layer.mergeAll(
      SystemClockLive,
      DeterministicIdGeneratorLive,
      InMemoryTicketRepositoryLive,
      handle.layer,
    )
    const program = Effect.gen(function* () {
      const apply = (id: never, eventId: never, at: never, seq: number) =>
        applyIssue({
          id: id,
          seq: seq,
          lane: "walkIn",
          displaySeq: seq,
          nameKana: KANA,
          phoneLast4: PHONE,
          freeText: null,
          appointmentAt: null,
          at: at,
          eventId: eventId,
        })
      const log = ({ id, seq }: { readonly id: unknown; readonly seq: number }) => ({
        tag: "IssueTicket",
        code: "I_USECASE_ISSUE_TICKET",
        data: { ticketId: id, seq },
      })
      const t1 = yield* issueAndPersist({ apply: apply as never, log })
      const t2 = yield* issueAndPersist({ apply: apply as never, log })
      return { t1, t2 }
    })
    const { t1, t2 } = await Effect.runPromise(program.pipe(Effect.provide(layer), Effect.orDie))
    expect(t2.seq).toBeGreaterThan(t1.seq)
    expect(t2.id).not.toBe(t1.id)
  })
})

describe("applyAndPersist", () => {
  it("persists with revision check + emits info log + returns next ticket", async () => {
    const handle = await Effect.runPromise(makeSilentLogger())
    const layer = Layer.mergeAll(
      SystemClockLive,
      DeterministicIdGeneratorLive,
      InMemoryTicketRepositoryLive,
      handle.layer,
    )
    const program = Effect.gen(function* () {
      // Seed a Called ticket via the issue + call-next combinators.
      const issued = yield* issueAndPersist({
        apply: (id, eventId, at, seq) =>
          applyIssue({
            id,
            seq,
            lane: "walkIn",
            displaySeq: seq,
            nameKana: KANA,
            phoneLast4: PHONE,
            freeText: null,
            appointmentAt: null,
            at,
            eventId,
          }),
        log: ({ id, seq }) => ({
          tag: "IssueTicket",
          code: "I_USECASE_ISSUE_TICKET",
          data: { ticketId: id, seq },
        }),
      })
      const repo = yield* TicketRepository
      const loadedWaiting = yield* repo.load(issued.id)
      const waiting = loadedWaiting.state as Waiting
      const called = yield* applyAndPersist({
        loaded: loadedWaiting,
        apply: (at, eventId) => applyCall(waiting, { at, eventId, calledBy: "staff" }),
        log: {
          tag: "CallNext",
          code: "I_USECASE_CALL_NEXT",
          data: { ticketId: issued.id, seq: issued.seq },
        },
      })
      const loadedCalled = yield* repo.load(issued.id)
      const calledState = loadedCalled.state as Called
      const served = yield* applyAndPersist({
        loaded: loadedCalled,
        apply: (at, eventId) => applyMarkServed(calledState, at, eventId),
        log: {
          tag: "MarkServed",
          code: "I_USECASE_MARK_SERVED",
          data: { ticketId: issued.id },
        },
      })
      const entries = yield* handle.emitted
      return { called, served, loadedCalledRev: loadedCalled.revision, entries }
    })

    const { called, served, loadedCalledRev, entries } = await Effect.runPromise(
      program.pipe(Effect.provide(layer), Effect.orDie),
    )

    expect(called.state).toBe("Called")
    expect(served.state).toBe("Served")
    expect(loadedCalledRev).toBeGreaterThanOrEqual(1)
    const tags = entries.map((e) => e.payload._tag)
    expect(tags).toContain("IssueTicket")
    expect(tags).toContain("CallNext")
    expect(tags).toContain("MarkServed")
  })

  it("propagates ConcurrencyError when revision is stale", async () => {
    const handle = await Effect.runPromise(makeSilentLogger())
    const layer = Layer.mergeAll(
      SystemClockLive,
      DeterministicIdGeneratorLive,
      InMemoryTicketRepositoryLive,
      handle.layer,
    )
    const program = Effect.gen(function* () {
      const issued = yield* issueAndPersist({
        apply: (id, eventId, at, seq) =>
          applyIssue({
            id,
            seq,
            lane: "walkIn",
            displaySeq: seq,
            nameKana: KANA,
            phoneLast4: PHONE,
            freeText: null,
            appointmentAt: null,
            at,
            eventId,
          }),
        log: ({ id, seq }) => ({
          tag: "IssueTicket",
          code: "I_USECASE_ISSUE_TICKET",
          data: { ticketId: id, seq },
        }),
      })
      const repo = yield* TicketRepository
      const loaded = yield* repo.load(issued.id)
      const waiting = loaded.state as Waiting
      // Advance the aggregate once so the next save with the original
      // revision is stale.
      yield* applyAndPersist({
        loaded,
        apply: (at, eventId) => applyCall(waiting, { at, eventId, calledBy: "staff" }),
        log: {
          tag: "CallNext",
          code: "I_USECASE_CALL_NEXT",
          data: { ticketId: issued.id, seq: issued.seq, actor: "staff" },
        },
      })
      // Re-using the *original* `loaded` (revision 1) now that the
      // aggregate has moved on must surface the optimistic-lock failure.
      return yield* applyAndPersist({
        loaded,
        apply: (at, eventId) => applyCall(waiting, { at, eventId, calledBy: "staff" }),
        log: {
          tag: "CallNext",
          code: "I_USECASE_CALL_NEXT",
          data: { ticketId: issued.id, seq: issued.seq, actor: "staff" },
        },
      })
    })

    const exit = await Effect.runPromiseExit(program.pipe(Effect.provide(layer)))
    expect(Exit.isFailure(exit)).toBe(true)
    const entries = await Effect.runPromise(handle.emitted)
    const saveFailed = entries.find((e) => e.payload._tag === "SaveFailed")
    expect(saveFailed?.level).toBe("error")
    expect(saveFailed?.payload.code).toBe("I_USECASE_SAVE_FAILED")
    expect(saveFailed?.payload.data.action).toBe("CallNext")
    expect(saveFailed?.payload.data.actor).toBe("staff")
    expect(saveFailed?.payload.data.errorTag).toBe("Concurrency")
  })
})
