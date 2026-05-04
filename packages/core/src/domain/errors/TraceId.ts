import { Either, Schema } from "effect"

/**
 * Request-scoped correlation identifier surfaced in logs, error
 * payloads, HTTP response headers, and event records. ULID-shaped
 * for time-ordering and high entropy. Must never be derived from
 * customer PII.
 */
export const TraceIdSchema = Schema.String.pipe(
  Schema.pattern(/^[0-9A-HJKMNP-TV-Z]{26}$/),
  Schema.brand("TraceId"),
)
export type TraceId = Schema.Schema.Type<typeof TraceIdSchema>

const isTraceIdSchema = Schema.is(TraceIdSchema)

export const isTraceId = (s: string): s is TraceId => isTraceIdSchema(s)

const decode = Schema.decodeUnknownEither(TraceIdSchema)

export const parseTraceId = (
  s: string,
): Either.Either<TraceId, { readonly _tag: "InvalidTraceId"; readonly value: string }> =>
  Either.mapLeft(decode(s), () => ({ _tag: "InvalidTraceId" as const, value: s }))
