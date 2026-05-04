import { Either } from "effect"
import { type DomainError, InvalidFreeText } from "../errors/DomainError.js"
import type { Brand } from "../types/Brand.js"

/**
 * Optional customer-supplied note. Plain text. Maximum 500 NFC code
 * points after trimming. Persisted PII; subject to the same retention
 * window as `NameKana` and `PhoneLast4`.
 *
 * Control characters other than `\n` (U+000A) and `\t` (U+0009) are
 * stripped.
 */
export type FreeText = Brand<string, "FreeText">

const MAX_LENGTH = 500

const CONTROL_RANGES = [
  [0x00, 0x08],
  [0x0b, 0x0c],
  [0x0e, 0x1f],
  [0x7f, 0x9f],
] as const

const stripControl = (s: string): string => {
  let out = ""
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0
    let drop = false
    for (const [lo, hi] of CONTROL_RANGES) {
      if (cp >= lo && cp <= hi) {
        drop = true
        break
      }
    }
    if (!drop) out += ch
  }
  return out
}

export const normalizeFreeText = (raw: string): string => stripControl(raw.normalize("NFC")).trim()

export const parseFreeText = (raw: string): Either.Either<FreeText, DomainError> => {
  const normalized = normalizeFreeText(raw)
  if ([...normalized].length > MAX_LENGTH) {
    return Either.left(InvalidFreeText(`exceeds ${MAX_LENGTH} characters`))
  }
  return Either.right(normalized as FreeText)
}
