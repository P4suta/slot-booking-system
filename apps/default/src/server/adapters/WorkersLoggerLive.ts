import { getCurrentTraceId, Logger, type LogPayload } from "@booking/core"
import { Effect, Layer } from "effect"

/**
 * Cloudflare Workers logger. Each `info` / `warn` / `error` call
 * serialises the {@link LogPayload} as JSON and emits it through
 * `console.{info,warn,error}`. Workers Logs ingests the structured
 * payload as a single line so the operator dashboard can filter on
 * `_tag` / `code` / `severity` / `traceId` without per-message regex.
 *
 * The logger reads the request-scoped `TraceId` from the
 * `CurrentTraceId` FiberRef and merges it into the emitted payload
 * when the call site has not provided one explicitly. The FiberRef
 * is seeded by the worker entry point (or the DO's `runUseCase`)
 * so a chain of nested sub-effects share the same trace without
 * threading it through every function signature.
 *
 * The adapter is deliberately stateless — Workers spin up a fresh
 * isolate per request and `console` is the runtime's structured
 * sink. ADR-0009 keeps PII out of every error / log payload, and
 * `toLogPayload` (in core) is the chokepoint that builds these.
 */
const decoratedEmit =
  (level: "info" | "warn" | "error") =>
  (payload: LogPayload): Effect.Effect<void> =>
    Effect.flatMap(getCurrentTraceId, (traceId) =>
      Effect.sync(() => {
        const decorated: LogPayload =
          payload.traceId !== undefined || traceId === undefined ? payload : { ...payload, traceId }
        const line = JSON.stringify(decorated)
        // biome-ignore lint/suspicious/noConsole: workers log sink
        if (level === "info") console.info(line)
        else if (level === "warn") console.warn(line)
        else console.error(line)
      }),
    )

export const WorkersLoggerLive: Layer.Layer<Logger> = Layer.succeed(
  Logger,
  Logger.of({
    info: decoratedEmit("info"),
    warn: decoratedEmit("warn"),
    error: decoratedEmit("error"),
  }),
)
