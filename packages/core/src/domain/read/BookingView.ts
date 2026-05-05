import type { Booking } from "../booking/Booking.js"

/**
 * Read-side view of a booking aggregate. Phase 0.7-α4 introduces the
 * type alias to **mark the read/write seam** so future divergence
 * (denormalised audit columns, materialised counters, capability
 * derivations) lands on the read side without leaking into transition
 * code on the write side.
 *
 * Today's shape is structurally identical to {@link Booking}; the
 * alias is the editorial seam, not a runtime conversion. A later
 * phase may brand the alias to enforce the boundary at the type level
 * (preventing a stale projection from being fed back into `apply`),
 * but doing so requires every read-side surface (D1 reader, GraphQL
 * resolver, audit log) to thread `asView(...)` consistently — that
 * lift is out of scope for α4.
 */
export type BookingView = Booking
