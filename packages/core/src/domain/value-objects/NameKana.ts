import { Either } from "effect"
import { type DomainError, InvalidNameKanaError } from "../errors/Errors.js"
import type { Brand } from "../types/Brand.js"

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
 * The PII storage policy (ADR-0009) keeps this field at most 2 years.
 */
export type NameKana = Brand<string, "NameKana">

const NAME_KANA_PATTERN = /^[゠-ヿ぀-ゟ･-ﾟー]+(?: [゠-ヿ぀-ゟ･-ﾟー]+)*$/

const MAX_LENGTH = 50

const fail = (reason: string) => Either.left(new InvalidNameKanaError({ reason }))

export const normalizeNameKana = (raw: string): string =>
  raw
    .normalize("NFKC")
    .replace(/[\s　]+/g, " ")
    .trim()

export const parseNameKana = (raw: string): Either.Either<NameKana, DomainError> => {
  const normalized = normalizeNameKana(raw)
  if (normalized.length === 0) return fail("empty")
  if (normalized.length > MAX_LENGTH) return fail("too long")
  if (!NAME_KANA_PATTERN.test(normalized)) return fail("contains non-kana characters")
  return Either.right(normalized as NameKana)
}
