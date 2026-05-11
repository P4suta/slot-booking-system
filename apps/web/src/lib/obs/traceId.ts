/**
 * Client-side ULID generator (Stage 20 / ADR-0088).
 *
 * Produces a 26-character Crockford base32 string that is structurally
 * identical to the server's {@link TraceId} (packages/core/src/domain/
 * errors/TraceId.ts) — 48 bits of unix-millis timestamp followed by 80
 * bits of `crypto.getRandomValues` entropy. We emit lowercase because
 * the customer-facing `X-Trace-Id` echo flows through Cloudflare which
 * is case-insensitive for headers; the server's TraceIdSchema accepts
 * the canonical uppercase form, so callers MUST uppercase before
 * round-tripping to a server endpoint. The downstream `api.ts`
 * instrumentation does this at the fetch-header boundary.
 *
 * Why a ULID rather than a UUIDv4: the same correlation id is now
 * used as the audit-log row primary key (ADR-0038), where the
 * time-ordered prefix gives an index-friendly insertion pattern and
 * lets ad-hoc operator queries `WHERE traceId > <minute>` work as a
 * coarse time filter without an explicit `at` column.
 *
 * Crockford alphabet excludes I/L/O/U to dodge OCR / handwriting
 * confusion with 1/0/V — the audit reporter sometimes prints these
 * onto a paper receipt, so the cost-free decision is to keep the
 * encoding identical end-to-end.
 */

// Crockford base32 (lowercase). 32 symbols; index → char.
const CROCKFORD_LOWER = "0123456789abcdefghjkmnpqrstvwxyz"

const TS_LEN = 10 // 48 bits / 5 bits-per-char = 9.6 → rounded to 10 chars
const RAND_LEN = 16 // 80 bits / 5 bits-per-char = 16 chars
const TOTAL_LEN = TS_LEN + RAND_LEN // 26 — matches server TraceId

/**
 * Encode a non-negative integer into `len` base-32 chars (right-
 * aligned, zero-padded). The input is bounded to 48 bits so the
 * multiplication-free divmod loop using JS Number is safe — at
 * 2^48 the IEEE-754 representation is still exact.
 */
const encodeNumber = (value: number, len: number): string => {
  let n = value
  let out = ""
  for (let i = 0; i < len; i += 1) {
    const idx = n & 31
    out = `${CROCKFORD_LOWER.charAt(idx)}${out}`
    // JavaScript bitwise ops coerce to int32; for the high bits we
    // must use arithmetic division. The right-shift `>>> 5` would
    // truncate the 48-bit timestamp at bit 32.
    n = Math.floor(n / 32)
  }
  return out
}

/**
 * Encode a `Uint8Array` of bytes (80 bits → 10 bytes) into Crockford
 * base-32. Standard MSB-first packing: walk the bytes accumulating a
 * bit-buffer, emit a char each time we have >= 5 bits.
 */
const encodeBytes = (bytes: Uint8Array, len: number): string => {
  let acc = 0
  let accBits = 0
  let out = ""
  for (let i = 0; i < bytes.length && out.length < len; i += 1) {
    acc = (acc << 8) | (bytes[i] ?? 0)
    accBits += 8
    while (accBits >= 5 && out.length < len) {
      const shift = accBits - 5
      const idx = (acc >> shift) & 31
      out += CROCKFORD_LOWER.charAt(idx)
      accBits -= 5
      acc &= (1 << accBits) - 1
    }
  }
  // Pad any short tail (should not happen for 10-byte input → 16 chars).
  while (out.length < len) out += "0"
  return out
}

const getRandomBytes = (n: number): Uint8Array => {
  const bytes = new Uint8Array(n)
  if (
    typeof globalThis.crypto !== "undefined" &&
    typeof globalThis.crypto.getRandomValues === "function"
  ) {
    globalThis.crypto.getRandomValues(bytes)
    return bytes
  }
  // Crypto API absence is a hard invariant violation: every browser
  // since 2017 ships it, and SSR runs under Node ≥ 16 which exposes
  // `webcrypto` as `globalThis.crypto`. Surfacing the failure is
  // better than a `Math.random` fallback that would silently weaken
  // the entropy guarantee callers rely on.
  throw new Error("crypto.getRandomValues unavailable; cannot generate traceId")
}

export const generateTraceId = (): string => {
  const ms = Date.now()
  const tsPart = encodeNumber(ms, TS_LEN)
  const randPart = encodeBytes(getRandomBytes(10), RAND_LEN)
  const id = `${tsPart}${randPart}`
  // Length is structurally guaranteed; the assertion guards against
  // a future refactor of the encoders silently dropping a char.
  if (id.length !== TOTAL_LEN)
    throw new Error(`traceId length invariant broken: ${String(id.length)}`)
  return id
}

/** Crockford lowercase regex matching {@link generateTraceId} output. */
export const TRACE_ID_RE = /^[0-9a-hjkmnp-tv-z]{26}$/
