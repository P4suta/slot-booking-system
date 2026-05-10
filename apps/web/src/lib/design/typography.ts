/**
 * Semantic typography scale. The runtime values live in `app.css`
 * (clamp() so the customer numeral hero scales 96–128 px across
 * viewport widths) and the call site references the role
 * (`text.numeral.hero`) rather than the px value, so a future
 * accessibility audit can re-balance the scale without touching
 * pages.
 *
 *   - `numeral.hero / xl / md` — the customer's own number (the
 *     queue's protagonist, ADR-0064 customer page is built around
 *     the hero numeral).
 *   - `body.lg / md / sm` — long-form copy + secondary
 *     descriptions.
 *   - `label.md / sm` — form labels + chips.
 *   - `mono.md / sm` — operator-side ticket ids (monospace for
 *     visual scanning of TypeID strings).
 */

const v = (name: string): string => `var(--${name})`

export const text = {
  numeral: {
    hero: v("text-numeral-hero"),
    xl: v("text-numeral-xl"),
    md: v("text-numeral-md"),
  },
  body: {
    lg: v("text-body-lg"),
    md: v("text-body-md"),
    sm: v("text-body-sm"),
  },
  label: {
    md: v("text-label-md"),
    sm: v("text-label-sm"),
  },
  mono: {
    md: v("text-mono-md"),
    sm: v("text-mono-sm"),
  },
} as const

export type Text = typeof text
