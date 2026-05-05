import type { LogPayload } from "../../domain/errors/Errors.js"
import type { TraceId } from "../../domain/errors/TraceId.js"

/**
 * Construct an informational `LogPayload` without going through an
 * error class. Use cases emit these for successful state transitions
 * the operator wants in the audit trail; the shape matches `toLogPayload`
 * so log sinks parse it uniformly with error logs (ADR-0009 / ADR-0026).
 */
export const infoPayload = (
  tag: string,
  code: string,
  data: Readonly<Record<string, unknown>>,
  traceId?: TraceId,
): LogPayload => ({
  _tag: tag,
  code,
  severity: "domain",
  data,
  ...(traceId !== undefined ? { traceId } : {}),
})
