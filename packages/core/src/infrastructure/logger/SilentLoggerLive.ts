import { Effect, Layer, Ref } from "effect"
import { Logger } from "../../application/ports/Logger.js"
import type { LogPayload } from "../../domain/errors/Errors.js"

/**
 * Silent {@link Logger} for tests. Drops every payload on the floor;
 * `lastN` retains the most recent emissions so a test can assert on
 * the structured log contract without coupling to a real sink.
 *
 * Production wires {@link WorkersLoggerLive} (ADR-0026), which
 * serialises the same payload as JSON to `console.{info,warn,error}`
 * for Workers Logs ingestion.
 */
type Level = "info" | "warn" | "error"
type Entry = { readonly level: Level; readonly payload: LogPayload }

export type SilentLoggerHandle = {
  readonly layer: Layer.Layer<Logger>
  readonly emitted: Effect.Effect<readonly Entry[]>
}

export const makeSilentLogger = (): Effect.Effect<SilentLoggerHandle> =>
  Effect.map(Ref.make<readonly Entry[]>([]), (ref) => {
    const push = (level: Level) => (payload: LogPayload) =>
      Ref.update(ref, (xs): readonly Entry[] => [...xs, { level, payload }])
    return {
      layer: Layer.succeed(
        Logger,
        Logger.of({
          info: push("info"),
          warn: push("warn"),
          error: push("error"),
        }),
      ),
      emitted: Ref.get(ref),
    }
  })

/** Convenience layer when the test does not care about emitted entries. */
export const SilentLoggerLive = Layer.succeed(
  Logger,
  Logger.of({
    info: () => Effect.void,
    warn: () => Effect.void,
    error: () => Effect.void,
  }),
)
