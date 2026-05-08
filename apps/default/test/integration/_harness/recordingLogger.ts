import type { Logger as LoggerType, LogPayload } from "@booking/core"
import { Logger } from "@booking/core"
import { Effect, Layer, Ref } from "effect"

/**
 * Recording Logger — captures every emitted `LogPayload` into an
 * in-memory ring so integration tests can assert log shape +
 * sequencing without depending on `console.*` capture or OTel
 * exporter mocks.
 *
 * The `RecordingLogger.layer` is a drop-in replacement for
 * `WorkersLoggerLive`; provide it inside the test's Effect runtime
 * to capture log emissions across the full DO + use-case stack.
 *
 * Usage:
 * ```ts
 * const recorder = await Effect.runPromise(makeRecordingLogger())
 * await Effect.runPromise(
 *   program.pipe(Effect.provide(recorder.layer), Effect.orDie)
 * )
 * const entries = await Effect.runPromise(recorder.emitted)
 * expect(entries).toContainEqual(
 *   expect.objectContaining({ level: "info", payload: ... })
 * )
 * ```
 */

export type LogLevel = "info" | "warn" | "error"

export type RecordedEntry = {
  readonly level: LogLevel
  readonly payload: LogPayload
}

export type RecordingLoggerHandle = {
  readonly layer: Layer.Layer<LoggerType>
  readonly emitted: Effect.Effect<readonly RecordedEntry[]>
  readonly clear: Effect.Effect<void>
}

export const makeRecordingLogger = (): Effect.Effect<RecordingLoggerHandle> =>
  Effect.map(Ref.make<readonly RecordedEntry[]>([]), (ref) => {
    const push =
      (level: LogLevel) =>
      (payload: LogPayload): Effect.Effect<void> =>
        Ref.update(ref, (xs): readonly RecordedEntry[] => [...xs, { level, payload }])
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
      clear: Ref.set(ref, []),
    }
  })

/** Filter helper — pull every entry whose `_tag` matches. */
export const entriesByTag = (entries: readonly RecordedEntry[], tag: string) =>
  entries.filter((e) => e.payload._tag === tag)

/** Filter helper — pull every entry whose `code` matches. */
export const entriesByCode = (entries: readonly RecordedEntry[], code: string) =>
  entries.filter((e) => e.payload.code === code)
