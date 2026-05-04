import { Either, ParseResult, Schema } from "effect"
import {
  type BookingCodeReason,
  type DomainError,
  InvalidBookingCodeError,
} from "../errors/Errors.js"
import { summarizeParse } from "../errors/fromParseError.js"

/* -------------------------------------------------------------------------- */
/* Encoding constants                                                          */
/* -------------------------------------------------------------------------- */

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
const CHECK_ALPHABET = `${ALPHABET}*~$=U`
const BODY_LENGTH = 6
const TOTAL_LENGTH = 7
const ALPHABET_SIZE = 32n
const CHECK_MOD = 37n

const ALPHABET_INDEX: ReadonlyMap<string, number> = new Map(
  [...ALPHABET].map((c, i) => [c, i] as const),
)
const CHECK_INDEX: ReadonlyMap<string, number> = new Map(
  [...CHECK_ALPHABET].map((c, i) => [c, i] as const),
)

/** Maximum representable body value, exclusive. */
export const BOOKING_CODE_KEYSPACE = ALPHABET_SIZE ** BigInt(BODY_LENGTH)

/* -------------------------------------------------------------------------- */
/* Pure helpers                                                                */
/* -------------------------------------------------------------------------- */

const isBodyChar = (c: string): boolean => ALPHABET_INDEX.has(c)

// Pre-condition: every char of `body` is in ALPHABET (caller validates).
const decodeBody = (body: string): bigint => {
  let acc = 0n
  for (const c of body) acc = acc * ALPHABET_SIZE + BigInt(ALPHABET.indexOf(c))
  return acc
}

const encodeBody = (value: bigint): string => {
  let v = value
  const buf: string[] = []
  for (let i = 0; i < BODY_LENGTH; i++) {
    const idx = Number(v % ALPHABET_SIZE)
    buf.push(ALPHABET.charAt(idx))
    v /= ALPHABET_SIZE
  }
  return buf.reverse().join("")
}

const checksumChar = (value: bigint): string => {
  const idx = Number(((value % CHECK_MOD) + CHECK_MOD) % CHECK_MOD)
  return CHECK_ALPHABET.charAt(idx)
}

/**
 * Strip presentational characters and fold Crockford confusables.
 *
 * - lowercase → uppercase
 * - dash, whitespace → removed
 * - `I`, `L` → `1`
 * - `O` → `0`
 *
 * Folding does **not** touch the U used as a check-only character.
 */
export const normalizeBookingCode = (input: string): string =>
  input.toUpperCase().replace(/[-\s]/g, "").replace(/[IL]/g, "1").replace(/O/g, "0")

/**
 * Pretty-print a code as `XXXX-XXX`.
 *
 * Defined on `string` so callers can format both validated `BookingCode`
 * values and inputs that are still being normalised in the UI.
 */
export const formatBookingCode = (code: string): string => `${code.slice(0, 4)}-${code.slice(4, 7)}`

/**
 * Step-by-step verifier. Returns `null` when `s` is a well-formed
 * normalised booking code (length, alphabet, checksum), otherwise the
 * tagged reason. Used both by `BookingCodeBrand` (where only the boolean
 * matters) and by the user-input codec (where the reason matters).
 */
const verifyNormalized = (s: string): BookingCodeReason | null => {
  if (s.length !== TOTAL_LENGTH) return "wrong-length"
  const body = s.slice(0, BODY_LENGTH)
  const check = s.slice(BODY_LENGTH)
  for (const c of body) if (!isBodyChar(c)) return "invalid-character"
  if (!CHECK_INDEX.has(check)) return "invalid-character"
  if (checksumChar(decodeBody(body)) !== check) return "checksum-mismatch"
  return null
}

/* -------------------------------------------------------------------------- */
/* Schema definitions                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Branded predicate over already-normalised, well-formed strings. This is
 * the "internal" representation used by both codecs as their decoded side.
 */
const BookingCodeBrand = Schema.String.pipe(
  Schema.filter((s) => verifyNormalized(s) === null),
  Schema.brand("BookingCode"),
)

/**
 * Public-facing reservation identifier. Crockford Base32 body of length
 * `BODY_LENGTH` plus a single mod-37 check character. Surfaced to humans
 * with a 4-3 dash (`XXXX-XXX`); the dash is presentational only.
 *
 * See ADR-0002 (entropy + encoding) and ADR-0014 (rejected before any
 * database lookup).
 */
export type BookingCode = Schema.Schema.Type<typeof BookingCodeBrand>

/**
 * `bigint` ↔ `BookingCode` codec — the canonical id-generation pathway.
 * `decode(v)` produces the 7-char string for the keyspace value `v`;
 * `encode(c)` recovers the original `bigint` from the body.
 */
export const BookingCodeSchema = Schema.transformOrFail(Schema.BigIntFromSelf, BookingCodeBrand, {
  strict: true,
  decode: (v, _opts, ast) =>
    v < 0n || v >= BOOKING_CODE_KEYSPACE
      ? ParseResult.fail(new ParseResult.Type(ast, v, "out of keyspace"))
      : ParseResult.succeed(`${encodeBody(v)}${checksumChar(v)}` as BookingCode),
  encode: (s) => ParseResult.succeed(decodeBody(s.slice(0, BODY_LENGTH))),
})

/**
 * `string` ↔ `BookingCode` codec — the user-input pathway. Decode performs
 * Crockford folding + presentational stripping, then verifies length,
 * alphabet, and checksum. The custom failure message is a
 * {@link BookingCodeReason} tag, recoverable through {@link summarizeParse}.
 */
export const BookingCodeFromUserInputSchema = Schema.transformOrFail(
  Schema.String,
  BookingCodeBrand,
  {
    strict: false,
    decode: (raw, _opts, ast) => {
      const normalized = normalizeBookingCode(raw)
      const reason = verifyNormalized(normalized)
      return reason === null
        ? ParseResult.succeed(normalized as BookingCode)
        : ParseResult.fail(new ParseResult.Type(ast, raw, reason))
    },
    encode: (s) => ParseResult.succeed(s),
  },
)

/* -------------------------------------------------------------------------- */
/* Public API (Either-flavoured wrappers around the codecs)                    */
/* -------------------------------------------------------------------------- */

const BOOKING_CODE_REASONS: ReadonlySet<string> = new Set<BookingCodeReason>([
  "wrong-length",
  "invalid-character",
  "checksum-mismatch",
])

const classifyBookingCodeReason = (raw: string): BookingCodeReason =>
  BOOKING_CODE_REASONS.has(raw) ? (raw as BookingCodeReason) : "invalid-character"

const decodeFromUserInput = Schema.decodeUnknownEither(BookingCodeFromUserInputSchema)
const decodeFromBigint = Schema.decodeUnknownEither(BookingCodeSchema)

/**
 * Encode a numeric body value into the canonical 7-char `BookingCode`.
 * Used by the `IdGenerator` port; pure function, no randomness inside.
 */
export const encodeBookingCode = (value: bigint): Either.Either<BookingCode, DomainError> =>
  Either.mapLeft(
    decodeFromBigint(value),
    () => new InvalidBookingCodeError({ reason: "invalid-character" }),
  )

/**
 * Parse arbitrary user input into a `BookingCode`. Performs:
 *  1. confusable folding + presentational stripping
 *  2. length check
 *  3. alphabet check (body + check char)
 *  4. mod-37 checksum verification
 *
 * Steps 1–4 happen **before** any database lookup (ADR-0014). 99 % of
 * typos terminate here.
 */
export const parseBookingCode = (raw: string): Either.Either<BookingCode, DomainError> =>
  Either.mapLeft(
    decodeFromUserInput(raw),
    (e) => new InvalidBookingCodeError({ reason: classifyBookingCodeReason(summarizeParse(e)) }),
  )
