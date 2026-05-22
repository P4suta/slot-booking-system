/**
 * Convert hiragana characters in `s` to their katakana counterparts
 * by shifting the Unicode block (U+3041..U+3096 → U+30A1..U+30F6).
 *
 * - Half-width katakana (U+FF66..U+FF9F) is left untouched; the
 *   `parseNameKana` upstream already accepts it and normalises later.
 * - Non-kana characters pass through unchanged.
 * - The transform is **idempotent**: applying it twice equals
 *   applying it once.
 *
 * Lives in `apps/web/src/lib/` because the rule is purely a
 * UI-affordance concern (the worker re-validates everything via
 * `parseNameKana`).
 */
const HIRAGANA_START = 0x3041
const HIRAGANA_END = 0x3096
const HIRA_TO_KATA_OFFSET = 0x60 // U+30A1 - U+3041

export const toKatakana = (s: string): string => {
  let out = ""
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0
    if (code >= HIRAGANA_START && code <= HIRAGANA_END) {
      out += String.fromCodePoint(code + HIRA_TO_KATA_OFFSET)
    } else {
      out += ch
    }
  }
  return out
}

/**
 * True if `s` contains at least one hiragana code point — used by the
 * issue / recover forms to decide whether to show a "↓ converts to
 * katakana" live preview. The visible preview is the workaround for
 * the fact that we cannot mutate the input value during IME
 * composition without breaking the composition itself.
 */
export const containsHiragana = (s: string): boolean => {
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0
    if (code >= HIRAGANA_START && code <= HIRAGANA_END) return true
  }
  return false
}

/**
 * Lightweight mirror of the server's `NameKanaSchema` (defined in
 * `packages/core/src/domain/value-objects/NameKana.ts`). Same pattern,
 * same length cap. The server validation is the source of truth; this
 * is only here so the form can warn the customer + disable the submit
 * button before a round-trip — typing 山田 (kanji) or "yamada" (ascii)
 * has nowhere to go in our katakana-only PII contract, so we should
 * stop the request at the client edge rather than emit a generic
 * `InvalidNameKana` error after the round-trip.
 *
 * Allowed characters mirror the server: katakana (U+30A0..U+30FF),
 * hiragana (U+3040..U+309F, since we convert to katakana on submit),
 * half-width katakana (U+FF65..U+FF9F), the prolonged-sound mark
 * "ー", and a single ASCII space between segments.
 */
const NAME_KANA_PATTERN = /^[゠-ヿ぀-ゟ･-ﾟー]+(?: [゠-ヿ぀-ゟ･-ﾟー]+)*$/
const NAME_KANA_MAX_LENGTH = 50

export type NameKanaValidation = "empty" | "ok" | "too_long" | "invalid_chars"

export const validateNameKana = (s: string): NameKanaValidation => {
  if (s.length === 0) return "empty"
  if (s.length > NAME_KANA_MAX_LENGTH) return "too_long"
  if (!NAME_KANA_PATTERN.test(s)) return "invalid_chars"
  return "ok"
}
