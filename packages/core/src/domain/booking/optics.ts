import { Optic } from "effect"
import type { Confirmed } from "./Booking.js"

/**
 * Lawful structural updates on the {@link Confirmed} aggregate variant.
 *
 * Effect's `Optic` module exposes `.key("…")` only on plain struct
 * types — `Booking` itself is a discriminated union and cannot be
 * lens-keyed directly (compile error). We therefore narrow first to
 * a single variant (`Confirmed`) and expose the lens at that scope.
 *
 * The lens-shaped update is a single named operation
 * (`Confirmed.slotLens.replace(newSlot, b)`) instead of an ad-hoc
 * struct rebuild that re-asserts every preserved field — so the only
 * field varying across the call is the one in scope.
 *
 * Lens laws (cross-validated by `optics.test.ts`):
 *   - get-set:  `slotLens.replace(slotLens.get(s), s) ≡ s`
 *   - set-get:  `slotLens.get(slotLens.replace(a, s)) ≡ a`
 *   - set-set:  `slotLens.replace(a2, slotLens.replace(a1, s)) ≡ slotLens.replace(a2, s)`
 */
export const confirmedSlotLens = Optic.id<Confirmed>().key("slot")
