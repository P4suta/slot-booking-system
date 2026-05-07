import { Result, Schema } from "effect"

/**
 * Request-scoped correlation identifier surfaced in logs, error
 * payloads, HTTP response headers, and event records. ULID-shaped
 * for time-ordering and high entropy. Must never be derived from
 * customer PII.
 */
export const TraceIdSchema = Schema.String.check(Schema.isPattern(/^[0-9A-HJKMNP-TV-Z]{26}$/)).pipe(
  Schema.brand("TraceId"),
)
export type TraceId = Schema.Schema.Type<typeof TraceIdSchema>

const isTraceIdSchema = Schema.is(TraceIdSchema)

export const isTraceId = (s: string): s is TraceId => isTraceIdSchema(s)

const decode = Schema.decodeUnknownResult(TraceIdSchema)

export const parseTraceId = (
  s: string,
): Result.Result<TraceId, { readonly _tag: "InvalidTraceId"; readonly value: string }> =>
  Result.mapError(decode(s), () => ({ _tag: "InvalidTraceId" as const, value: s }))

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
const HEX_RE = /^[0-9a-f]{32}$/i
const ALL_ZERO_HEX_RE = /^0+$/

/**
 * Re-encode a 128-bit OTel hex traceId (32 chars) as a Crockford
 * base32 ULID (26 chars). Both encodings carry the same 128 bits;
 * the runbook (ADR-0038) documents this cross-link so an operator
 * can pivot between OTel-native trace search and audit-log queries.
 *
 * Returns undefined for a no-op span's all-zero traceId, since that
 * is OTel's sentinel for "no recording" — log/audit sinks should
 * omit `traceId` entirely rather than persist a sentinel value.
 */
export const traceIdFromHex = (hex: string): TraceId | undefined => {
  if (!HEX_RE.test(hex) || ALL_ZERO_HEX_RE.test(hex)) return undefined
  let n = BigInt(`0x${hex}`)
  let out = ""
  for (let i = 0; i < 26; i++) {
    out = `${CROCKFORD.charAt(Number(n & 31n))}${out}`
    n = n >> 5n
  }
  return out as TraceId
}
