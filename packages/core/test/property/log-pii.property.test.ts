import { Effect, Layer } from "effect"
import * as fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
  CallNext,
  CancelTicket,
  IssueTicket,
  MarkNoShow,
  MarkServed,
  Recall,
} from "../../src/application/usecases/queue/index.js"
import { SystemClockLive } from "../../src/infrastructure/clock/SystemClockLive.js"
import { InMemoryTicketRepositoryLive } from "../../src/infrastructure/eventsourced/InMemoryEventSourcedRepositoryLive.js"
import { DeterministicIdGeneratorLive } from "../../src/infrastructure/id/DeterministicIdGeneratorLive.js"
import { makeSilentLogger } from "../../src/infrastructure/logger/SilentLoggerLive.js"
import { arbCustomerHandle } from "../_arb/index.js"
import { numRuns } from "../_arb/numRuns.js"

/**
 * Runtime PII discipline (ADR-0009 / ADR-0026) — every log entry the
 * use cases emit through `infoPayload` must omit customer PII. The
 * use-case layer constructs payloads from `ticketId` + `seq` + actor
 * fields only, never the raw `nameKana` / `phoneLast4` / `freeText`,
 * but a future refactor could regress this without anyone noticing
 * because the Logger contract does not enforce it.
 *
 * The property below drives all six use cases through the InMemory
 * stack with a fast-check-generated CustomerHandle, captures every
 * log entry through `makeSilentLogger`, and asserts the JSON-
 * serialised entries contain neither the kana nor the phone-last-4
 * values that were just persisted. The property fails the moment a
 * use case starts logging the handle.
 */

describe("log PII discipline (property)", () => {
  it("no log entry from any use-case path contains the kana or phoneLast4", () => {
    return fc.assert(
      fc.asyncProperty(arbCustomerHandle, async (handle) => {
        const captureHandle = await Effect.runPromise(makeSilentLogger())
        const program = Effect.gen(function* () {
          // Drive the full lifecycle so every use case's log emit
          // lands in the captured stream. Cancel covers the
          // customer-handle path (which is the most likely place a
          // careless refactor would log the handle).
          const t = yield* IssueTicket({ handle, freeText: null })
          yield* CallNext()
          yield* Recall(t.id, "staff")
          yield* CallNext()
          yield* MarkNoShow(t.id, "staff")
          // A second ticket exercises CancelTicket with the
          // customer handle (authenticateCustomer path).
          const t2 = yield* IssueTicket({ handle, freeText: null })
          yield* CancelTicket(t2.id, "customer", "test-cancel", handle)
          // A third ticket runs the Served terminal path.
          const t3 = yield* IssueTicket({ handle, freeText: null })
          yield* CallNext()
          yield* MarkServed(t3.id)
          return yield* captureHandle.emitted
        })
        const layer = Layer.mergeAll(
          SystemClockLive,
          DeterministicIdGeneratorLive,
          InMemoryTicketRepositoryLive,
          captureHandle.layer,
        )
        const entries = await Effect.runPromise(program.pipe(Effect.provide(layer), Effect.orDie))
        const json = JSON.stringify(entries)
        // Look for the JSON-encoded form (`"<value>"`) so a digit
        // substring that happens to land inside a TypeID
        // (`"tkt_000…001"` contains `"0000"` as a substring) does not
        // false-positive. A real PII leak would surface the value as
        // its own JSON string token, surrounded by quotes.
        const quotedKana = JSON.stringify(handle.nameKana)
        const quotedPhone = JSON.stringify(handle.phoneLast4)
        expect(
          json,
          `log entry leaked nameKana ${handle.nameKana as string}: ${json}`,
        ).not.toContain(quotedKana)
        expect(
          json,
          `log entry leaked phoneLast4 ${handle.phoneLast4 as string}: ${json}`,
        ).not.toContain(quotedPhone)
      }),
      { numRuns: numRuns(30, 100) },
    )
  })
})
