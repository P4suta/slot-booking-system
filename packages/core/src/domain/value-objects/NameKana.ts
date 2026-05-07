import { Result, Schema, SchemaGetter } from "effect"
import { type DomainError, InvalidNameKanaError } from "../errors/Errors.js"
import { summarizeParse } from "../errors/fromParseError.js"

const NAME_KANA_PATTERN = /^[゠-ヿ぀-ゟ･-ﾟー]+(?: [゠-ヿ぀-ゟ･-ﾟー]+)*$/
const MAX_LENGTH = 50

/**
 * Normalise raw input: NFKC fold (half-width → full-width), collapse any
 * mix of ASCII / full-width whitespace into a single ASCII space, then
 * trim. Idempotent: `normalizeNameKana(normalizeNameKana(x)) === normalizeNameKana(x)`.
 */
export const normalizeNameKana = (raw: string): string =>
  raw
    .normalize("NFKC")
    .replace(/[\s　]+/g, " ")
    .trim()

/**
 * Customer-supplied full name in katakana (or hiragana). Trimmed,
 * normalised to a single space between segments, length 1..50.
 *
 * Allowed characters:
 *   - Katakana (`U+30A0`..`U+30FF`) including dakuten / handakuten
 *   - Hiragana (`U+3040`..`U+309F`) for users who type it that way
 *   - Half-width katakana (`U+FF65`..`U+FF9F`)
 *   - ASCII space and full-width ideographic space (` ` and `U+3000`),
 *     normalised to a single ASCII space between non-space tokens.
 *
 * Encoded as a `Schema.transform` whose `decode` runs `normalizeNameKana`
 * before the brand's refinement filters apply, and whose `encode` is
 * identity (the branded output is already normalised).
 *
 * The PII storage policy (ADR-0009) keeps this field at most 2 years.
 */
const NameKanaBrand = Schema.String.check(
  Schema.makeFilter((s) => s.length > 0 && s.length <= MAX_LENGTH && NAME_KANA_PATTERN.test(s)),
).pipe(Schema.brand("NameKana"))

export const NameKanaSchema = Schema.String.pipe(
  Schema.decodeTo(NameKanaBrand, {
    decode: SchemaGetter.transform(normalizeNameKana),
    encode: SchemaGetter.transform((norm: string) => norm),
  }),
)
export type NameKana = Schema.Schema.Type<typeof NameKanaSchema>

const decode = Schema.decodeUnknownResult(NameKanaSchema)

export const parseNameKana = (raw: string): Result.Result<NameKana, DomainError> =>
  Result.mapError(decode(raw), (e) => new InvalidNameKanaError({ reason: summarizeParse(e) }))
