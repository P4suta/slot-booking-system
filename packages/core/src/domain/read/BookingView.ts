import type { Brand } from "effect"
import type { Booking } from "../booking/Booking.js"

/**
 * Read-side view of a booking aggregate. Structurally identical to
 * {@link Booking} but **branded** so a `BookingView` cannot silently
 * cross back into the write side: `apply(view, command)` is a
 * compile-time error, forcing callers to acknowledge the read/write
 * seam explicitly. The brand is phantom — no runtime change — and
 * costs zero bytes of payload.
 *
 * Phase 3 (BI / pre-typestate) — the brand is a stepping stone toward
 * the indexed-monad `ViewT<S>` (Phase 3.4) that will narrow the view
 * by phantom state. Branding now means call sites already thread the
 * conversion, so the indexed lift can rebrand at the same seam
 * without churn.
 */
export type BookingView = Booking & Brand.Brand<"BookingView">

/**
 * Witness the read/write seam: take a `Booking` (write-side aggregate
 * fresh from `apply` or a Schema decode) and present it as a
 * `BookingView` for projection / mirror / audit consumers.
 *
 * The cast is a compile-time-only operation — `Brand` carries no
 * runtime data — so this is a free abstraction.
 */
export const asView = (booking: Booking): BookingView => booking as BookingView
