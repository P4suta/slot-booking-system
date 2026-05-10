import { Temporal } from "@js-temporal/polyfill"
import { Effect, Layer, Schema } from "effect"
import * as fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
  CallNext,
  CancelTicket,
  IssueTicket,
  MarkServed,
} from "../../src/application/usecases/queue/index.js"
import type { Lane } from "../../src/domain/queue/Lane.js"
import type { CustomerHandle } from "../../src/domain/value-objects/CustomerHandle.js"
import { NameKanaSchema } from "../../src/domain/value-objects/NameKana.js"
import { PhoneLast4Schema } from "../../src/domain/value-objects/PhoneLast4.js"
import { SystemClockLive } from "../../src/infrastructure/clock/SystemClockLive.js"
import { InMemoryTicketRepositoryLive } from "../../src/infrastructure/eventsourced/InMemoryEventSourcedRepositoryLive.js"
import { UlidIdGeneratorLive } from "../../src/infrastructure/id/UlidIdGeneratorLive.js"
import { SilentLoggerLive } from "../../src/infrastructure/logger/SilentLoggerLive.js"
import { numRuns } from "../_arb/numRuns.js"

/**
 * ADR-0069 — `(nameKana, phoneLast4)` is the active-set primary key.
 *
 *   1. issue × N with the same handle yields a single ticket.
 *   2. lane / appointmentAt / freeText supplied to a re-issue are
 *      ignored; the first issue's intent wins.
 *   3. terminal states (Served / Cancelled / NoShow) release the
 *      handle — a re-issue after a terminal transition mints a new
 *      ticket.
 *   4. distinct handles always produce distinct tickets.
 */

const makeEnv = () =>
  Layer.mergeAll(
    SystemClockLive,
    UlidIdGeneratorLive,
    InMemoryTicketRepositoryLive,
    SilentLoggerLive,
  )

const runScenario = <A, E, R>(scenario: Effect.Effect<A, E, R>): Promise<A> =>
  Effect.runPromise(scenario.pipe(Effect.provide(makeEnv())) as unknown as Effect.Effect<A>)

const handleOf = (kana: string, last4: string): CustomerHandle => ({
  nameKana: Schema.decodeUnknownSync(NameKanaSchema)(kana),
  phoneLast4: Schema.decodeUnknownSync(PhoneLast4Schema)(last4),
})

const arbKana = fc.stringMatching(/^[ァ-ヶ]{2,6}$/u)
const arbLast4 = fc.stringMatching(/^[0-9]{4}$/)
const arbHandle: fc.Arbitrary<CustomerHandle> = fc
  .tuple(arbKana, arbLast4)
  .map(([k, p]) => handleOf(k, p))
const arbLane: fc.Arbitrary<Lane> = fc.constantFrom("walkIn", "priority", "reservation")
const APPT_AT = Temporal.Instant.from("2026-05-15T10:30:00Z")

describe("ADR-0069 issue idempotency — handle as active-set primary key", () => {
  it("N consecutive issues with the same handle yield the same ticket id", () =>
    fc.assert(
      fc.asyncProperty(arbHandle, fc.integer({ min: 1, max: 10 }), async (handle, n) => {
        await runScenario(
          Effect.gen(function* () {
            const first = yield* IssueTicket({ handle, freeText: null })
            for (let i = 0; i < n; i += 1) {
              const repeat = yield* IssueTicket({ handle, freeText: null })
              expect(repeat.id).toBe(first.id)
              expect(repeat.seq).toBe(first.seq)
            }
          }),
        )
      }),
      { numRuns: numRuns(40, 120) },
    ))

  it("re-issue ignores lane / appointmentAt — first issue's intent wins", () =>
    fc.assert(
      fc.asyncProperty(arbHandle, arbLane, arbLane, async (handle, lane1, lane2) => {
        await runScenario(
          Effect.gen(function* () {
            const t1 = yield* IssueTicket({
              handle,
              freeText: null,
              lane: lane1,
              ...(lane1 === "reservation" ? { appointmentAt: APPT_AT } : {}),
            })
            const t2 = yield* IssueTicket({
              handle,
              freeText: null,
              lane: lane2,
              ...(lane2 === "reservation" ? { appointmentAt: APPT_AT } : {}),
            })
            expect(t2.id).toBe(t1.id)
            expect(t2.lane).toBe(t1.lane)
            expect(t2.appointmentAt).toEqual(t1.appointmentAt)
          }),
        )
      }),
      { numRuns: numRuns(40, 120) },
    ))

  it("terminal state releases the handle — re-issue after Served mints new ticket", () =>
    fc.assert(
      fc.asyncProperty(arbHandle, async (handle) => {
        await runScenario(
          Effect.gen(function* () {
            const t1 = yield* IssueTicket({ handle, freeText: null })
            yield* CallNext()
            yield* MarkServed(t1.id)
            const t2 = yield* IssueTicket({ handle, freeText: null })
            expect(t2.id).not.toBe(t1.id)
            expect(t2.state).toBe("Waiting")
          }),
        )
      }),
      { numRuns: numRuns(20, 60) },
    ))

  it("terminal state releases the handle — re-issue after Cancel mints new ticket", () =>
    fc.assert(
      fc.asyncProperty(arbHandle, async (handle) => {
        await runScenario(
          Effect.gen(function* () {
            const t1 = yield* IssueTicket({ handle, freeText: null })
            yield* CancelTicket(t1.id, "customer", "test-release", handle)
            const t2 = yield* IssueTicket({ handle, freeText: null })
            expect(t2.id).not.toBe(t1.id)
          }),
        )
      }),
      { numRuns: numRuns(20, 60) },
    ))

  it("distinct handles always produce distinct tickets", () =>
    fc.assert(
      fc.asyncProperty(arbHandle, arbHandle, async (a, b) => {
        // Skip the degenerate same-handle case the property test
        // can sample by accident from a small alphabet.
        fc.pre(a.nameKana !== b.nameKana || a.phoneLast4 !== b.phoneLast4)
        await runScenario(
          Effect.gen(function* () {
            const t1 = yield* IssueTicket({ handle: a, freeText: null })
            const t2 = yield* IssueTicket({ handle: b, freeText: null })
            expect(t2.id).not.toBe(t1.id)
          }),
        )
      }),
      { numRuns: numRuns(40, 120) },
    ))
})
