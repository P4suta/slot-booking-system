import { Result, Schema, SchemaGetter } from "effect"
import { type DomainError, InvalidFreeTextError } from "../errors/Errors.js"
import { summarizeParse } from "../errors/fromParseError.js"

const MAX_LENGTH = 500

/**
 * True iff `cp` is a forbidden control character: C0 minus `\t` (U+0009)
 * and `\n` (U+000A), plus DEL (U+007F) and C1 (U+0080..U+009F).
 *
 * Total over `number`; no defensive branches.
 */
const isControlChar = (cp: number): boolean =>
  (cp >= 0x00 && cp <= 0x08) ||
  cp === 0x0b ||
  cp === 0x0c ||
  (cp >= 0x0e && cp <= 0x1f) ||
  (cp >= 0x7f && cp <= 0x9f)

const stripControl = (s: string): string => {
  let out = ""
  for (let i = 0; i < s.length; i++) {
    if (!isControlChar(s.charCodeAt(i))) out += s.charAt(i)
  }
  return out
}

/**
 * Normalise raw input: NFC fold, strip C0/C1/DEL controls (keeping `\t`
 * and `\n`), then trim. Idempotent.
 */
export const normalizeFreeText = (raw: string): string => stripControl(raw.normalize("NFC")).trim()

/** Code-point count via `for…of`; surrogate pairs collapse into one. */
const codePointCount = (s: string): number => {
  let n = 0
  for (const _ of s) n++
  return n
}

/**
 * Optional customer-supplied note. Plain text. Maximum 500 NFC code
 * points after trimming. Persisted PII; subject to the same retention
 * window as `NameKana` and `PhoneLast4`.
 *
 * Control characters other than `\n` (U+000A) and `\t` (U+0009) are
 * stripped during decode.
 */
const FreeTextBrand = Schema.String.check(
  Schema.makeFilter((s) => codePointCount(s) <= MAX_LENGTH),
).pipe(Schema.brand("FreeText"))

export const FreeTextSchema = Schema.String.pipe(
  Schema.decodeTo(FreeTextBrand, {
    decode: SchemaGetter.transform(normalizeFreeText),
    encode: SchemaGetter.transform((norm: string) => norm),
  }),
)
export type FreeText = Schema.Schema.Type<typeof FreeTextSchema>

const decode = Schema.decodeUnknownResult(FreeTextSchema)

export const parseFreeText = (raw: string): Result.Result<FreeText, DomainError> =>
  Result.mapError(decode(raw), (e) => new InvalidFreeTextError({ reason: summarizeParse(e) }))
