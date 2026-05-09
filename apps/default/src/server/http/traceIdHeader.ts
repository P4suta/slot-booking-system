import { type TraceId, traceIdFromHex } from "@booking/core"
import { trace as otelTrace } from "@opentelemetry/api"

/** Canonical response header name carrying the request's trace id. */
export const TRACE_ID_HEADER = "X-Trace-Id"

/**
 * Read the active OTel span's traceId, re-encoded as a 26-char
 * Crockford ULID so it lines up with the audit / log sinks that
 * already pin the ULID-shaped `TraceId` brand (ADR-0009 / ADR-0038).
 *
 * Returns `null` when no span is active (test fibers without an
 * `instrument(...)` wrap, scheduled handlers without OTel wiring)
 * or when the span is no-op (all-zero traceId sentinel).
 *
 * Safe to call from any non-Effect context (Hono middleware, DO
 * method, raw worker handler) — `getActiveSpan()` reads the global
 * tracer's current context, which `@microlabs/otel-cf-workers`
 * populates at the worker entry.
 */
export const currentTraceId = (): TraceId | null => {
  const span = otelTrace.getActiveSpan()
  if (span === undefined) return null
  return traceIdFromHex(span.spanContext().traceId) ?? null
}
