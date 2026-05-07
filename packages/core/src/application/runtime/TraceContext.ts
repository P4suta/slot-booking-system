import { Effect, Option } from "effect"
import { type TraceId, traceIdFromHex } from "../../domain/errors/TraceId.js"

/**
 * Read the current trace id from the active OTel span.
 *
 * `instrument(handler, otelConfig)` from `@microlabs/otel-cf-workers`
 * is the worker root and always starts a span before any Effect runs;
 * `Effect.currentSpan` therefore yields the OTel-native span context
 * and we re-encode its 32-hex `traceId` to a 26-char Crockford ULID
 * for the audit / log sinks that ADR-0009 fixes on a ULID-shaped
 * `TraceId` brand. Same 128 bits, two display encodings — the
 * runbook (ADR-0038) documents the pivot procedure so operators can
 * cross-link OTel-native trace search and audit-log queries.
 *
 * Returns undefined when no span has wrapped the effect (test fibers
 * without an `Effect.withSpan` wrap, scheduled handlers without OTel
 * wiring) or when the span is no-op (all-zero traceId sentinel).
 * Sinks treat undefined as "omit traceId entirely" rather than
 * persisting a sentinel value.
 */
export const getCurrentTraceId: Effect.Effect<TraceId | undefined> = Effect.map(
  Effect.option(Effect.currentSpan),
  (maybe) => (Option.isSome(maybe) ? traceIdFromHex(maybe.value.traceId) : undefined),
)
