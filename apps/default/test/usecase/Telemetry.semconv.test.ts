import {
  CancelBooking,
  ConfirmBooking,
  DeterministicIdGeneratorLive,
  ExpireBooking,
  encodeBookingCode,
  HoldSlot,
  InMemoryEventSourcedBookingRepositoryLive,
  mintAvailableSlot,
  newBookingId,
  newProviderId,
  newResourceId,
  newServiceId,
  PiiPurger,
  PurgeStalePii,
  parseFreeText,
  parseNameKana,
  parsePhoneLast4,
  RescheduleBooking,
  SilentLoggerLive,
  SystemClockLive,
} from "@booking/core"
import { Temporal } from "@js-temporal/polyfill"
import { Effect, Layer, Result, Tracer } from "effect"
import { describe, expect, it } from "vitest"

/**
 * Phase 3 PR#8 / commit 12 — pin the OpenTelemetry semconv-aligned
 * attribute set every use-case `withSpan` carrier emits.
 *
 * Lives under `apps/default/test/` because it bundles a custom Effect
 * `Tracer` implementation; the test surface is the Effect-side
 * tracer abstraction that `withSpan` writes into. The OTel-bound
 * exporter pipeline (worker `instrument(...)` → Honeycomb / Jaeger)
 * is a separate concern asserted manually via `just dev-up` in
 * commit 15. Here we assert the attribute table that travels into
 * **every** tracer back-end the worker swaps in.
 *
 * The recording tracer is the simplest possible `Tracer.Tracer`
 * implementation: each `span()` call returns a `NativeSpan` whose
 * end-of-life attribute Map we capture into an outer array. This
 * mirrors how the production tracer (Effect's default) accumulates
 * attributes from `Effect.withSpan(name, { attributes })` and
 * subsequent `Effect.annotateCurrentSpan(...)` calls.
 *
 * Each use-case opens its `usecase.<Verb>` span unconditionally —
 * before the inner body's first `yield*` — so even if the inner
 * program fails (missing aggregate, wrong code, …) the span still
 * fires with a complete attribute set. The tests therefore use
 * `Effect.catchCause` and assert on the captured span, not on the
 * use-case outcome.
 */

const sampleSlot = () => {
  const tz = "UTC"
  const start = Temporal.Instant.from("2026-05-09T01:00:00Z").toZonedDateTimeISO(tz)
  const end = Temporal.Instant.from("2026-05-09T02:00:00Z").toZonedDateTimeISO(tz)
  return mintAvailableSlot({
    serviceId: newServiceId(),
    start,
    end,
    providerId: newProviderId(),
    resourceIds: [newResourceId()],
  })
}

const TEST_LAYER = Layer.mergeAll(
  SystemClockLive,
  DeterministicIdGeneratorLive,
  InMemoryEventSourcedBookingRepositoryLive,
  SilentLoggerLive,
)

const fakePurger = Layer.succeed(
  PiiPurger,
  PiiPurger.of({ purgeOlderThan: () => Effect.succeed(0) }),
)

const phone = (s: string) => Result.getOrThrow(parsePhoneLast4(s))
const kana = (s: string) => Result.getOrThrow(parseNameKana(s))
const freeText = (s: string) => Result.getOrThrow(parseFreeText(s))
const bookingCode = (n: bigint) => Result.getOrThrow(encodeBookingCode(n))

type RecordedSpan = {
  readonly name: string
  readonly attributes: ReadonlyMap<string, unknown>
}

/**
 * Run an Effect under a recording tracer that captures every `withSpan`
 * frame's name + final attribute Map. The inner body's outcome is
 * suppressed (`catchCause`) — we only inspect the captured span set,
 * which fires regardless of inner success / failure. Returns the
 * spans observed during the run.
 */
const captureSpans = async <A, E, R>(eff: Effect.Effect<A, E, R>): Promise<RecordedSpan[]> => {
  const recorded: RecordedSpan[] = []
  const recordingTracer: Tracer.Tracer = {
    span: (options) => {
      const span = new Tracer.NativeSpan(options)
      // Capture at span end so attributes added via subsequent
      // `annotateCurrentSpan` calls are included.
      const originalEnd = span.end.bind(span)
      span.end = (endTime, exit) => {
        recorded.push({ name: span.name, attributes: new Map(span.attributes) })
        originalEnd(endTime, exit)
      }
      return span
    },
  }
  await Effect.runPromise(
    eff.pipe(
      Effect.withTracer(recordingTracer),
      Effect.catchCause(() => Effect.void),
    ) as Effect.Effect<unknown>,
  )
  return recorded
}

const findSpan = (spans: readonly RecordedSpan[], name: string) =>
  spans.find((s) => s.name === name)

describe("use-case semconv attribute table (commit 12)", () => {
  it("HoldSlot span carries graphql.operation.* + usecase.invocation.kind=graphql", async () => {
    const program = HoldSlot({
      slot: sampleSlot(),
      nameKana: kana("ヤマダ タロウ"),
      phoneLast4: phone("1234"),
      freeText: freeText("test"),
      source: "online",
    }).pipe(Effect.provide(TEST_LAYER))

    const spans = await captureSpans(program)
    const span = findSpan(spans, "usecase.HoldSlot")
    expect(span).toBeDefined()
    expect(span?.attributes.get("graphql.operation.type")).toBe("mutation")
    expect(span?.attributes.get("graphql.operation.name")).toBe("HoldSlot")
    expect(span?.attributes.get("usecase.invocation.kind")).toBe("graphql")
  })

  it("CancelBooking span carries graphql.operation.* + usecase.invocation.kind=graphql", async () => {
    const program = CancelBooking({
      code: bookingCode(1n),
      phoneLast4: phone("1234"),
      reason: "test",
    }).pipe(Effect.provide(TEST_LAYER))

    const spans = await captureSpans(program)
    const span = findSpan(spans, "usecase.CancelBooking")
    expect(span).toBeDefined()
    expect(span?.attributes.get("graphql.operation.type")).toBe("mutation")
    expect(span?.attributes.get("graphql.operation.name")).toBe("CancelBooking")
    expect(span?.attributes.get("usecase.invocation.kind")).toBe("graphql")
  })

  it("ConfirmBooking span carries graphql.operation.* + usecase.invocation.kind=graphql", async () => {
    const program = ConfirmBooking({
      code: bookingCode(2n),
      phoneLast4: phone("1234"),
    }).pipe(Effect.provide(TEST_LAYER))

    const spans = await captureSpans(program)
    const span = findSpan(spans, "usecase.ConfirmBooking")
    expect(span).toBeDefined()
    expect(span?.attributes.get("graphql.operation.type")).toBe("mutation")
    expect(span?.attributes.get("graphql.operation.name")).toBe("ConfirmBooking")
    expect(span?.attributes.get("usecase.invocation.kind")).toBe("graphql")
  })

  it("RescheduleBooking span carries graphql.operation.* + usecase.invocation.kind=graphql", async () => {
    const program = RescheduleBooking({
      code: bookingCode(3n),
      phoneLast4: phone("1234"),
      newSlot: sampleSlot(),
    }).pipe(Effect.provide(TEST_LAYER))

    const spans = await captureSpans(program)
    const span = findSpan(spans, "usecase.RescheduleBooking")
    expect(span).toBeDefined()
    expect(span?.attributes.get("graphql.operation.type")).toBe("mutation")
    expect(span?.attributes.get("graphql.operation.name")).toBe("RescheduleBooking")
    expect(span?.attributes.get("usecase.invocation.kind")).toBe("graphql")
  })

  it("ExpireBooking span carries usecase.invocation.kind=scheduled (no graphql.*)", async () => {
    const program = ExpireBooking({ bookingId: newBookingId() }).pipe(Effect.provide(TEST_LAYER))

    const spans = await captureSpans(program)
    const span = findSpan(spans, "usecase.ExpireBooking")
    expect(span).toBeDefined()
    expect(span?.attributes.get("usecase.invocation.kind")).toBe("scheduled")
    expect(span?.attributes.has("graphql.operation.type")).toBe(false)
    expect(span?.attributes.has("graphql.operation.name")).toBe(false)
  })

  it("PurgeStalePii span carries usecase.invocation.kind=scheduled (cron-driven)", async () => {
    const program = PurgeStalePii().pipe(
      Effect.provide(Layer.mergeAll(fakePurger, SilentLoggerLive)),
    )

    const spans = await captureSpans(program)
    const span = findSpan(spans, "usecase.PurgeStalePii")
    expect(span).toBeDefined()
    expect(span?.attributes.get("usecase.invocation.kind")).toBe("scheduled")
    expect(span?.attributes.has("graphql.operation.type")).toBe(false)
    expect(span?.attributes.has("graphql.operation.name")).toBe(false)
  })
})
