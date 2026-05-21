/**
 * Centralised message lookup that wraps the paraglide-generated
 * `m.<key>()` functions. Routes call these helpers instead of
 * pattern-matching error tags inline so:
 *
 *   1. Adding a new error tag in `packages/core` only requires
 *      adding the `error_<Tag>` key to `messages/{ja,en}.json` —
 *      nothing in the route layer changes.
 *   2. Unknown tags fall back to `error_unknown` in **one** place,
 *      not in every page's `messageOf` switch (Stage 13 collapses
 *      three duplicate switches into this single registry).
 *   3. The lookup is testable as a pure function without a DOM.
 *
 * The catalogue source of truth lives in `apps/web/messages/{ja,en}.json`;
 * `apps/web/test/i18n/paraglide-keys.test.ts` pins parity + every
 * registry tag's presence.
 */

// `messages.js` re-exports every key under both bare and quoted form.
// We re-export it as `m` so route components import paraglide through
// the wrapper module — keeps `lib/` the single integration point and
// avoids a `$lib/paraglide/...` alias that doesn't actually exist
// (paraglide compiles to `src/paraglide/`, sibling to `src/lib/`).
import * as m from "../paraglide/messages.js"

export { m }

type MessageFn = () => string
type Catalogue = Readonly<Partial<Record<string, MessageFn>>>

const catalogue: Catalogue = m as unknown as Catalogue

/**
 * Look up the friendly copy for an error `_tag`. Unknown tags fall
 * back to `error_unknown` so the UI is never blank — the customer
 * still sees a coherent message and the trace id (rendered alongside)
 * pivots to the structured-log row for diagnosis.
 */
export const errorMessage = (tag: string): string => {
  const fn = catalogue[`error_${tag}`]
  if (fn !== undefined) return fn()
  return m.error_unknown()
}

export type EmptyContext =
  | "calling"
  | "overdue"
  | "waiting"
  | "terminal"
  | "byHandle404"
  | "slotPicker"

export const emptyState = (ctx: EmptyContext): string => {
  switch (ctx) {
    case "calling":
      return m.empty_calling()
    case "overdue":
      return m.empty_overdue()
    case "waiting":
      return m.empty_waiting()
    case "terminal":
      return m.empty_terminal()
    case "byHandle404":
      return m.empty_byHandle404()
    case "slotPicker":
      return m.empty_slotPicker()
  }
}

export type LoadingContext = "ticket" | "revalidate" | "reschedule" | "slots"

export const loadingState = (ctx: LoadingContext): string => {
  switch (ctx) {
    case "ticket":
      return m.loading_ticket()
    case "revalidate":
      return m.loading_revalidate()
    case "reschedule":
      return m.loading_reschedule()
    case "slots":
      return m.loading_slots()
  }
}

export type HelpContext = "reschedule" | "recoverHandle" | "notifyPermission" | "slotPicker"

export const helpText = (ctx: HelpContext): string => {
  switch (ctx) {
    case "reschedule":
      return m.help_reschedule()
    case "recoverHandle":
      return m.help_recoverHandle()
    case "notifyPermission":
      return m.help_notifyPermission()
    case "slotPicker":
      return m.help_slotPicker()
  }
}
