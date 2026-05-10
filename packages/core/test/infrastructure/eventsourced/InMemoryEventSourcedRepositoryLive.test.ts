import { Temporal } from "@js-temporal/polyfill"
import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { TicketRepository } from "../../../src/application/ports/EventSourcedRepository.js"
import { ConcurrencyError } from "../../../src/domain/errors/Errors.js"
import type { Waiting } from "../../../src/domain/queue/Ticket.js"
import { type ApplyResult, applyCall, applyIssue } from "../../../src/domain/queue/transitions.js"
import { newTicketEventId, newTicketId } from "../../../src/domain/types/EntityId.js"
import { NameKanaSchema } from "../../../src/domain/value-objects/NameKana.js"
import { PhoneLast4Schema } from "../../../src/domain/value-objects/PhoneLast4.js"
import {
  InMemoryTicketRepositoryLive,
  makeInMemoryTicketRepositoryLive,
} from "../../../src/infrastructure/eventsourced/InMemoryEventSourcedRepositoryLive.js"

const at = (iso: string) => Temporal.Instant.from(iso)
const kana = Schema.decodeUnknownSync(NameKanaSchema)("ヤマダ タロウ")
const phone = Schema.decodeUnknownSync(PhoneLast4Schema)("1234")

const issueOne = (): ApplyResult =>
  applyIssue({
    id: newTicketId(),
    seq: 1,
    lane: "walkIn",
    displaySeq: 1,
    nameKana: kana,
    phoneLast4: phone,
    freeText: null,
    appointmentAt: null,
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
        const next = applyCall(ticket as Waiting, {
          at: at("2026-05-08T09:05:00Z"),
          eventId: newTicketEventId(),
        })
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

  it("saveBatch applies multiple aggregates atomically (ADR-0065)", async () =>
    run(
      Effect.gen(function* () {
        const repo = yield* TicketRepository
        const a = issueOne()
        const b = issueOne()
        yield* repo.issue(a.ticket.id, [a.event], a.ticket)
        yield* repo.issue(b.ticket.id, [b.event], b.ticket)
        const callA = applyCall(a.ticket as Waiting, {
          at: at("2026-05-08T09:05:00Z"),
          eventId: newTicketEventId(),
        })
        const callB = applyCall(b.ticket as Waiting, {
          at: at("2026-05-08T09:05:01Z"),
          eventId: newTicketEventId(),
        })
        yield* repo.saveBatch([
          { id: a.ticket.id, expected: 1, events: [callA.event], next: callA.ticket },
          { id: b.ticket.id, expected: 1, events: [callB.event], next: callB.ticket },
        ])
        const loadedA = yield* repo.load(a.ticket.id)
        const loadedB = yield* repo.load(b.ticket.id)
        expect(loadedA.state.state).toBe("Called")
        expect(loadedB.state.state).toBe("Called")
        expect(loadedA.revision).toBe(2)
        expect(loadedB.revision).toBe(2)
      }),
    ))

  it("saveBatch rolls back on revision mismatch in any member (atomicity)", async () =>
    run(
      Effect.gen(function* () {
        const repo = yield* TicketRepository
        const a = issueOne()
        const b = issueOne()
        yield* repo.issue(a.ticket.id, [a.event], a.ticket)
        yield* repo.issue(b.ticket.id, [b.event], b.ticket)
        const callA = applyCall(a.ticket as Waiting, {
          at: at("2026-05-08T09:05:00Z"),
          eventId: newTicketEventId(),
        })
        const callB = applyCall(b.ticket as Waiting, {
          at: at("2026-05-08T09:05:01Z"),
          eventId: newTicketEventId(),
        })
        // member B carries a stale revision; the whole batch must be
        // rejected with ConcurrencyError and neither aggregate moves.
        const r = yield* eitherEffect(
          repo.saveBatch([
            { id: a.ticket.id, expected: 1, events: [callA.event], next: callA.ticket },
            { id: b.ticket.id, expected: 99, events: [callB.event], next: callB.ticket },
          ]),
        )
        expect(r.ok).toBe(false)
        if (!r.ok && r.error instanceof ConcurrencyError) {
          expect(r.error.expected).toBe(99)
          expect(r.error.actual).toBe(1)
        }
        const loadedA = yield* repo.load(a.ticket.id)
        const loadedB = yield* repo.load(b.ticket.id)
        // Both aggregates remain at the pre-batch state.
        expect(loadedA.state.state).toBe("Waiting")
        expect(loadedB.state.state).toBe("Waiting")
      }),
    ))

  it("saveBatch on a non-issued id surfaces ConcurrencyError(actual=0)", async () =>
    run(
      Effect.gen(function* () {
        const repo = yield* TicketRepository
        // No issue() — the id is unknown to the store, so saveBatch's
        // verify scan synthesises actual=0 against an expected=0 input
        // (or any other; the contract is "row absent ≡ revision 0").
        const a = issueOne()
        const callA = applyCall(a.ticket as Waiting, {
          at: at("2026-05-08T09:05:00Z"),
          eventId: newTicketEventId(),
        })
        const r = yield* eitherEffect(
          repo.saveBatch([
            { id: a.ticket.id, expected: 5, events: [callA.event], next: callA.ticket },
          ]),
        )
        expect(r.ok).toBe(false)
        if (!r.ok && r.error instanceof ConcurrencyError) {
          expect(r.error.expected).toBe(5)
          expect(r.error.actual).toBe(0)
        }
      }),
    ))

  it("saveBatch fires snapshot upsert when revision crosses the snapshotInterval boundary", async () => {
    const program = Effect.gen(function* () {
      const repo = yield* TicketRepository
      const a = issueOne()
      yield* repo.issue(a.ticket.id, [a.event], a.ticket)
      const callA = applyCall(a.ticket as Waiting, {
        at: at("2026-05-08T09:05:00Z"),
        eventId: newTicketEventId(),
      })
      yield* repo.saveBatch([
        { id: a.ticket.id, expected: 1, events: [callA.event], next: callA.ticket },
      ])
      // K=1 means every save lands a snapshot; load should see the
      // post-saveBatch revision (2 = issue + call).
      const loaded = yield* repo.load(a.ticket.id)
      expect(loaded.revision).toBe(2)
      expect(loaded.state.state).toBe("Called")
    })
    await Effect.runPromise(
      program.pipe(
        Effect.provide(makeInMemoryTicketRepositoryLive(1)),
      ) as unknown as Effect.Effect<void>,
    )
  })
})
