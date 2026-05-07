import { Context, type Effect } from "effect"
import type { LogPayload } from "../../domain/errors/Errors.js"

/**
 * Structured logger port. Methods take a {@link LogPayload}-shaped record so
 * the log surface stays uniform across info/warn/error severities and so
 * sinks can rely on `_tag`, `code`, `severity`, `traceId`, `data` being
 * present (ADR-0009 forbids customer PII in any field).
 */
export class Logger extends Context.Service<
  Logger,
  {
    readonly info: (payload: LogPayload) => Effect.Effect<void>
    readonly warn: (payload: LogPayload) => Effect.Effect<void>
    readonly error: (payload: LogPayload) => Effect.Effect<void>
  }
>()("@booking/core/Logger") {}
