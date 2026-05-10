/**
 * Design tokens — semantic colour / spacing / radius / shadow names
 * the components reference. The runtime value lives in `app.css`'s
 * `:root` (light) and `[data-theme="dark"]` (dark) blocks; this
 * module exists so TypeScript code can write `tokens.color.surface`
 * and survive a future palette overhaul (the string just changes
 * the CSS variable it resolves to, not the call site).
 *
 * Naming follows the Apple Health / Linear convention: tokens are
 * **role-named** (`color.fg.primary`), never hue-named (`color.gray-900`).
 * The customer flow and the staff flow share the same tokens; the
 * visual distinction comes from the typography scale + density,
 * not from a different palette.
 *
 * Per ADR-0062 / ADR-0063 the queue exposes `lane` (walkIn /
 * priority / reservation) and `state` (Waiting / Called / Serving /
 * Served / NoShow / Cancelled); the `color.state.*` tokens cover
 * the active states and the lane chips reuse `color.fg.muted` +
 * `color.bg.subtle` so industry-agnostic neutrality is preserved.
 */

const v = (name: string): string => `var(--${name})`

export const tokens = {
  color: {
    bg: {
      surface: v("color-bg-surface"),
      subtle: v("color-bg-subtle"),
      raised: v("color-bg-raised"),
      inverted: v("color-bg-inverted"),
    },
    fg: {
      primary: v("color-fg-primary"),
      secondary: v("color-fg-secondary"),
      muted: v("color-fg-muted"),
      inverted: v("color-fg-inverted"),
    },
    border: {
      subtle: v("color-border-subtle"),
      strong: v("color-border-strong"),
      focus: v("color-border-focus"),
    },
    state: {
      waiting: v("color-state-waiting"),
      called: v("color-state-called"),
      serving: v("color-state-serving"),
      done: v("color-state-done"),
      danger: v("color-state-danger"),
    },
    accent: {
      primary: v("color-accent-primary"),
      onPrimary: v("color-accent-on-primary"),
    },
  },
  space: {
    0: v("space-0"),
    1: v("space-1"),
    2: v("space-2"),
    3: v("space-3"),
    4: v("space-4"),
    5: v("space-5"),
    6: v("space-6"),
    8: v("space-8"),
    10: v("space-10"),
    12: v("space-12"),
  },
  radius: {
    sm: v("radius-sm"),
    md: v("radius-md"),
    lg: v("radius-lg"),
    pill: v("radius-pill"),
  },
  shadow: {
    sm: v("shadow-sm"),
    md: v("shadow-md"),
    lg: v("shadow-lg"),
  },
  z: {
    base: 0,
    raised: 10,
    sticky: 100,
    overlay: 1000,
    modal: 2000,
    toast: 3000,
  },
} as const

export type Tokens = typeof tokens
