import { Temporal } from "@js-temporal/polyfill"
import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { TicketRepository } from "../../../src/application/ports/EventSourcedRepository.js"
import { ConcurrencyError } from "../../../src/domain/errors/Errors.js"
import type { Waiting } from "../../../src/domain/queue/Ticket.js"
import {
  type ApplyResult,
  applyCallNext,
  applyIssue,
} from "../../../src/domain/queue/transitions.js"
import { newTicketEventId, newTicketId } from "../../../src/domain/types/EntityId.js"
import { NameKanaSchema } from "../../../src/domain/value-objects/NameKana.js"
import { PhoneLast4Schema } from "../../../src/domain/value-objects/PhoneLast4.js"
import { InMemoryTicketRepositoryLive } from "../../../src/infrastructure/eventsourced/InMemoryEventSourcedRepositoryLive.js"

const at = (iso: string) => Temporal.Instant.from(iso)
const kana = Schema.decodeUnknownSync(NameKanaSchema)("ヤマダ タロウ")
const phone = Schema.decodeUnknownSync(PhoneLast4Schema)("1234")

const issueOne = (): ApplyResult =>
  applyIssue({
    id: newTicketId(),
    seq: 1,
    nameKana: kana,
    phoneLast4: phone,
    freeText: null,
    at: at("2026-05-08T09:00:00Z"),
    eventId: newTicketEventId(),
  })

const eitherEffect = <A, E, R>(eff: Effect.Effect<A, E, R>) =>
  Effect.matchEffect(eff, {
    onSuccess: (value) => Effect.succeed({ ok: true as const, value }),
    onFailure: (error) => Effect.succeed({ ok: false as const, error }),
  })

const run = <A, E, R>(scenario: Effect.Effect<A, E, R>) =>
  Effect.runPromise(
    scenario.pipe(Effect.provide(InMemoryTicketRepositoryLive)) as unknown as Effect.Effect<A>,
  )

/**
 * Pin the failure paths of the in-memory adapter — issue-twice and
 * save-with-stale-revision — so the ConcurrencyError envelope is
 * reachable through ordinary unit tests rather than only through
 * production-mode race fixtures.
 */
describe("InMemoryTicketRepositoryLive", () => {
  it("issue then load round-trips the aggregate", async () =>
    run(
      Effect.gen(function* () {
        const repo = yield* TicketRepository
        const { ticket, event } = issueOne()
        yield* repo.issue(ticket.id, [event], ticket)
        const loaded = yield* repo.load(ticket.id)
        expect(loaded.state.id).toBe(ticket.id)
        expect(loaded.revision).toBe(1)
      }),
    ))

  it("issue twice for the same id yields ConcurrencyError", async () =>
    run(
      Effect.gen(function* () {
        const repo = yield* TicketRepository
        const { ticket, event } = issueOne()
        yield* repo.issue(ticket.id, [event], ticket)
        const r = yield* eitherEffect(repo.issue(ticket.id, [event], ticket))
        expect(r.ok).toBe(false)
        if (!r.ok && r.error instanceof ConcurrencyError) {
          expect(r.error.expected).toBe(0)
          expect(r.error.actual).toBe(1)
        }
      }),
    ))

  it("load on a missing ticket yields AggregateNotFound", async () =>
    run(
      Effect.gen(function* () {
        const repo = yield* TicketRepository
        const r = yield* eitherEffect(repo.load(newTicketId()))
        expect(r.ok).toBe(false)
        if (!r.ok) {
          const err = r.error as { readonly _tag: string }
          expect(err._tag).toBe("AggregateNotFound")
        }
      }),
    ))

  it("save with a stale revision against an existing ticket reports the actual revision", async () =>
    run(
      Effect.gen(function* () {
        const repo = yield* TicketRepository
        const { ticket, event } = issueOne()
        yield* repo.issue(ticket.id, [event], ticket)
        const next = applyCallNext(
          ticket as Waiting,
          at("2026-05-08T09:05:00Z"),
          newTicketEventId(),
        )
        // Issue brought revision to 1; saving with `expected = 0` is
        // a stale-read race.
        const r = yield* eitherEffect(repo.save(ticket.id, 0, [next.event], next.ticket))
        expect(r.ok).toBe(false)
        if (!r.ok && r.error instanceof ConcurrencyError) {
          expect(r.error.expected).toBe(0)
          expect(r.error.actual).toBe(1)
        }
      }),
    ))

  it("save against a missing ticket also surfaces a ConcurrencyError envelope", async () =>
    run(
      Effect.gen(function* () {
        const repo = yield* TicketRepository
        const { ticket, event } = issueOne()
        // Never issued — the save body sees no row and synthesises
        // `actual = 0`. This is the "lost the issue race" branch.
        const r = yield* eitherEffect(repo.save(ticket.id, 0, [event], ticket))
        expect(r.ok).toBe(false)
        if (!r.ok && r.error instanceof ConcurrencyError) {
          expect(r.error.expected).toBe(0)
          expect(r.error.actual).toBe(0)
        }
      }),
    ))

  it("nextSeq yields a strictly increasing counter", async () =>
    run(
      Effect.gen(function* () {
        const repo = yield* TicketRepository
        const a = yield* repo.nextSeq()
        const b = yield* repo.nextSeq()
        expect(b).toBe(a + 1)
      }),
    ))

  it("listAll returns the projection over all stored tickets", async () =>
    run(
      Effect.gen(function* () {
        const repo = yield* TicketRepository
        const a = issueOne()
        const b = issueOne()
        yield* repo.issue(a.ticket.id, [a.event], a.ticket)
        yield* repo.issue(b.ticket.id, [b.event], b.ticket)
        const all = yield* repo.listAll()
        expect(all).toHaveLength(2)
      }),
    ))
})
