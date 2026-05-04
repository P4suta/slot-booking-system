import { Either } from "effect"
import type { Brand } from "../types/Brand.js"

/**
 * Request-scoped correlation identifier surfaced in logs, error
 * payloads, HTTP response headers, and event records. ULID-shaped
 * for time-ordering and high entropy. Must never be derived from
 * customer PII.
 */
export type TraceId = Brand<string, "TraceId">

const TRACE_ID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/

export const isTraceId = (s: string): s is TraceId => TRACE_ID_PATTERN.test(s)

export const parseTraceId = (
  s: string,
): Either.Either<TraceId, { readonly _tag: "InvalidTraceId"; readonly value: string }> =>
  isTraceId(s) ? Either.right(s) : Either.left({ _tag: "InvalidTraceId", value: s })
