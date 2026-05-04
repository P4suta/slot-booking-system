import { Either } from "effect"
import { type DomainError, InvalidBookingCode } from "../errors/DomainError.js"
import type { Brand } from "../types/Brand.js"

/**
 * Public-facing reservation identifier. Crockford Base32 body of length
 * `BODY_LENGTH` plus a single mod-37 check character. Surfaced to humans
 * with a 4-3 dash (`XXXX-XXX`); the dash is presentational only.
 *
 * See ADR-0002 (entropy + encoding) and ADR-0014 (rejected before any
 * database lookup).
 */
export type BookingCode = Brand<string, "BookingCode">

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
export const normalizeBookingCode = (input: string): string => {
  const upper = input.toUpperCase().replace(/[-\s]/g, "")
  return upper.replace(/[IL]/g, "1").replace(/O/g, "0")
}

const isBodyChar = (c: string): boolean => ALPHABET_INDEX.has(c)

const decodeBody = (body: string): bigint => {
  let acc = 0n
  for (const c of body) {
    const idx = ALPHABET_INDEX.get(c)
    if (idx === undefined) return -1n
    acc = acc * ALPHABET_SIZE + BigInt(idx)
  }
  return acc
}

const encodeBody = (value: bigint): string => {
  let v = value
  const buf: string[] = []
  for (let i = 0; i < BODY_LENGTH; i++) {
    const idx = Number(v % ALPHABET_SIZE)
    buf.push(ALPHABET[idx] ?? "0")
    v /= ALPHABET_SIZE
  }
  return buf.reverse().join("")
}

const checksumChar = (value: bigint): string => {
  const idx = Number(((value % CHECK_MOD) + CHECK_MOD) % CHECK_MOD)
  return CHECK_ALPHABET[idx] ?? "0"
}

/**
 * Encode a numeric body value into the canonical 7-char `BookingCode`.
 * Used by the `IdGenerator` port; pure function, no randomness inside.
 */
export const encodeBookingCode = (value: bigint): Either.Either<BookingCode, DomainError> => {
  if (value < 0n || value >= BOOKING_CODE_KEYSPACE) {
    return Either.left(InvalidBookingCode("invalid-character"))
  }
  const body = encodeBody(value)
  const code = `${body}${checksumChar(value)}` as BookingCode
  return Either.right(code)
}

/**
 * Pretty-print a code as `XXXX-XXX`.
 *
 * Defined on `string` so callers can format both validated `BookingCode`
 * values and inputs that are still being normalised in the UI.
 */
export const formatBookingCode = (code: string): string => `${code.slice(0, 4)}-${code.slice(4, 7)}`

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
export const parseBookingCode = (raw: string): Either.Either<BookingCode, DomainError> => {
  const normalized = normalizeBookingCode(raw)
  if (normalized.length !== TOTAL_LENGTH) {
    return Either.left(InvalidBookingCode("wrong-length"))
  }
  const body = normalized.slice(0, BODY_LENGTH)
  const check = normalized.slice(BODY_LENGTH)
  for (const c of body) {
    if (!isBodyChar(c)) {
      return Either.left(InvalidBookingCode("invalid-character"))
    }
  }
  if (!CHECK_INDEX.has(check)) {
    return Either.left(InvalidBookingCode("invalid-character"))
  }
  const value = decodeBody(body)
  if (value < 0n) {
    return Either.left(InvalidBookingCode("invalid-character"))
  }
  if (checksumChar(value) !== check) {
    return Either.left(InvalidBookingCode("checksum-mismatch"))
  }
  return Either.right(normalized as BookingCode)
}
