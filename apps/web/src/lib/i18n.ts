import { m } from "../paraglide/messages.js"

/**
 * Phase 3 / paraglide-js i18n integration.
 *
 * The 30-key static MessageMap that lived here was the temporary
 * stand-in for paraglide-js's compile-time message contract. It is
 * gone — every error tag now resolves to a typed message function
 * generated under `src/paraglide/` from `messages/{ja,en}.json`. A
 * key referenced here that doesn't exist in the JSON catalogue is
 * a build-time error rather than a missing-tag silent fallback.
 *
 * Lookup is keyed on `BookingError.tag` (the `_tag` of the
 * underlying `DomainError`), reshaped into the paraglide message id
 * `error_<tag>`. Recompile after editing the JSON files via
 * `pnpm -F web run paraglide` (also runs as a build prebuild).
 */

type Locale = "ja" | "en"

type LocalisableError = {
  readonly tag: string | null
  readonly i18nKey?: string | null
  readonly message?: string | null
}

type MessageFn = (inputs?: Record<string, never>, options?: { locale?: Locale }) => string

const messages = m as unknown as Record<string, MessageFn | undefined>

const messageFor = (tag: string, locale: Locale): string | undefined => {
  const fn = messages[`error_${tag}`]
  return fn?.({}, { locale })
}

/**
 * Resolve a `BookingError` to a localised user-facing message.
 *
 * Lookup order:
 *   1. `m.error_<tag>` — the paraglide-compiled catalogue entry.
 *   2. `error.message` — the GraphQL boundary's English fallback.
 *   3. `m.error_unknown` — the locale-appropriate "unexpected" string.
 */
export const localiseBookingError = (error: LocalisableError, locale: Locale = "ja"): string => {
  if (error.tag !== null) {
    const fromCatalogue = messageFor(error.tag, locale)
    if (fromCatalogue !== undefined) return fromCatalogue
  }
  if (error.message != null && error.message.length > 0) return error.message
  return messageFor("unknown", locale) ?? "An unexpected error occurred"
}
