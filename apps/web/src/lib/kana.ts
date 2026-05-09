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
