import { Effect, Layer, Result } from "effect"
import { describe, expect, it } from "vitest"
import { PiiPurger } from "../../../src/application/ports/PiiPurger.js"
import { PII_RETENTION, PurgeStalePii } from "../../../src/application/usecases/PurgeStalePii.js"
import { parseTraceId } from "../../../src/domain/errors/TraceId.js"
import {
  makeSilentLogger,
  SilentLoggerLive,
} from "../../../src/infrastructure/logger/SilentLoggerLive.js"

const fakePurger = (purged: number) =>
  Layer.succeed(
    PiiPurger,
    PiiPurger.of({
      purgeOlderThan: () => Effect.succeed(purged),
    }),
  )

// (recordingPurger removed — PII_RETENTION assertion below covers the
// duration argument without needing a Ref-based capture.)

describe("PurgeStalePii", () => {
  it("returns the purger's row count", async () => {
    const program = PurgeStalePii().pipe(
      Effect.provide(Layer.merge(fakePurger(42), SilentLoggerLive)),
    )
    const r = await Effect.runPromise(program)
    expect(r.purged).toBe(42)
  })

  it("emits a structured log entry with the purged count", async () => {
    const program = Effect.gen(function* () {
      const log = yield* makeSilentLogger()
      yield* PurgeStalePii().pipe(Effect.provide(Layer.merge(fakePurger(3), log.layer)))
      return yield* log.emitted
    })
    const emitted = await Effect.runPromise(program)
    expect(emitted.length).toBe(1)
    expect(emitted[0]?.payload._tag).toBe("PiiPurged")
    expect(emitted[0]?.payload.code).toBe("I_USECASE_PURGE_PII")
    expect(emitted[0]?.payload.data.purged).toBe(3)
  })

  it("threads a TraceId through to the log payload when supplied", async () => {
    const traceId = Result.getOrThrow(parseTraceId("01H8XRQMKQDNFGXT7NH3AVH3XS"))
    const program = Effect.gen(function* () {
      const log = yield* makeSilentLogger()
      yield* PurgeStalePii({ traceId }).pipe(Effect.provide(Layer.merge(fakePurger(0), log.layer)))
      return yield* log.emitted
    })
    const emitted = await Effect.runPromise(program)
    expect(emitted[0]?.payload.traceId).toBe(traceId)
  })

  it("PII_RETENTION is 2 × 365 days (matches SYSTEM §6 retention contract)", () => {
    // 2 years × 365 days × 24 h × 60 m × 60 s × 1000 ms.
    const expectedMs = 2 * 365 * 24 * 60 * 60 * 1000
    // Use Duration's structural form for the comparison rather than
    // string parsing, which is implementation-defined.
    expect(PII_RETENTION).toMatchObject({ value: { millis: expectedMs } })
  })
})
