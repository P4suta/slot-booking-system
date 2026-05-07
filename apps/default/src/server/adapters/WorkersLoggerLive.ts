import { getCurrentTraceId, Logger, type LogPayload } from "@booking/core"
import { Effect, Layer, Option } from "effect"

/**
 * Cloudflare Workers logger. Each `info` / `warn` / `error` call
 * serialises the {@link LogPayload} as JSON and emits it through
 * `console.{info,warn,error}`. Workers Logs ingests the structured
 * payload as a single line so the operator dashboard can filter on
 * `_tag` / `code` / `severity` / `traceId` without per-message regex.
 *
 * The logger reads the request-scoped `TraceId` from the active
 * OTel span via `getCurrentTraceId` (re-encoded from the OTel hex
 * traceId to a Crockford ULID) and merges it into the emitted
 * payload when the call site has not provided one explicitly.
 * `instrument(handler, otelConfig)` from `@microlabs/otel-cf-workers`
 * is the worker root and always starts a span before any Effect
 * runs, so the trace is shared across nested sub-effects without
 * threading it through every function signature.
 *
 * The adapter is deliberately stateless — Workers spin up a fresh
 * isolate per request and `console` is the runtime's structured
 * sink. ADR-0009 keeps PII out of every error / log payload, and
 * `toLogPayload` (in core) is the chokepoint that builds these.
 */
/**
 * Phase 2.6 / BI-9 — emit each log call as a span event in addition
 * to the existing JSON-line console sink. The `Effect.currentSpan`
 * call returns `Cause.NoSuchElementException` when no span is
 * active (e.g. tests, scheduled handlers without OTel wiring); the
 * inner effect short-circuits via `Effect.option` so the span event
 * is genuinely additive — Workers Logs ingestion is unaffected.
 */
const emitSpanEvent =
  (level: "info" | "warn" | "error") =>
  (payload: LogPayload): Effect.Effect<void> =>
    Effect.flatMap(Effect.option(Effect.currentSpan), (maybeSpan) =>
      Effect.sync(() => {
        if (Option.isSome(maybeSpan)) {
          maybeSpan.value.event(`log.${level}`, BigInt(Date.now()) * 1_000_000n, {
            "log.severity": payload.severity,
            "log.code": payload.code,
            "error.type": payload._tag,
            ...payload.data,
          })
        }
      }),
    )

const decoratedEmit =
  (level: "info" | "warn" | "error") =>
  (payload: LogPayload): Effect.Effect<void> =>
    Effect.flatMap(getCurrentTraceId, (traceId) =>
      Effect.zipRight(
        emitSpanEvent(level)(payload),
        Effect.sync(() => {
          const decorated: LogPayload =
            payload.traceId !== undefined || traceId === undefined
              ? payload
              : { ...payload, traceId }
          const line = JSON.stringify(decorated)
          // biome-ignore lint/suspicious/noConsole: workers log sink
          if (level === "info") console.info(line)
          else if (level === "warn") console.warn(line)
          else console.error(line)
        }),
      ),
    )

export const WorkersLoggerLive: Layer.Layer<Logger> = Layer.succeed(
  Logger,
  Logger.of({
    info: decoratedEmit("info"),
    warn: decoratedEmit("warn"),
    error: decoratedEmit("error"),
  }),
)
