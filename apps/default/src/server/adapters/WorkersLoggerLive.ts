import { Logger, type LogPayload } from "@booking/core"
import { Effect, Layer } from "effect"

/**
 * Cloudflare Workers logger. Each `info` / `warn` / `error` call
 * serialises the {@link LogPayload} as JSON and emits it through
 * `console.{info,warn,error}`. Workers Logs ingests the structured
 * payload as a single line so the operator dashboard can filter on
 * `_tag` / `code` / `severity` / `traceId` without per-message regex.
 *
 * The adapter is deliberately stateless — Workers spin up a fresh
 * isolate per request and `console` is the runtime's structured
 * sink. ADR-0009 keeps PII out of every error / log payload, and
 * `toLogPayload` (in core) is the chokepoint that builds these.
 */
export const WorkersLoggerLive: Layer.Layer<Logger> = Layer.succeed(
  Logger,
  Logger.of({
    info: (payload: LogPayload) =>
      Effect.sync(() => {
        // biome-ignore lint/suspicious/noConsole: workers log sink
        console.info(JSON.stringify(payload))
      }),
    warn: (payload: LogPayload) =>
      Effect.sync(() => {
        console.warn(JSON.stringify(payload))
      }),
    error: (payload: LogPayload) =>
      Effect.sync(() => {
        console.error(JSON.stringify(payload))
      }),
  }),
)
