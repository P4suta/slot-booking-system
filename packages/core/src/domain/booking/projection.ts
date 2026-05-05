import { Match } from "effect"
import type { BookingEvent } from "../events/BookingEvent.js"
import type {
  Booking,
  BookingCommon,
  Cancelled,
  Completed,
  Confirmed,
  Held,
  NoShow,
} from "./Booking.js"

/**
 * Read-side projection over the booking event log (Step 15, ADR-0024
 * draft). Given a snapshot and one event, return the next snapshot;
 * `replay` folds an entire event stream back into the current state.
 *
 * The write side (`transitions.ts` `apply`) already emits a
 * `BookingEvent` alongside the next `Booking`. Phase 1 will rely on
 * the event log as the source of truth and rebuild the snapshot via
 * `replay`; this module is the single function any read model
 * (current `Booking`, indexes, materialised views) consumes.
 *
 * `applyEvent(snapshot, event)` and `apply(snapshot, command)` agree
 * on the resulting booking when the event was the one apply emitted —
 * this invariant is checked by `projection.test.ts`.
 */

const common = (b: BookingCommon): BookingCommon => ({
  id: b.id,
  code: b.code,
  serviceId: b.serviceId,
  providerId: b.providerId,
  resourceIds: b.resourceIds,
  slot: b.slot,
  source: b.source,
  nameKana: b.nameKana,
  phoneLast4: b.phoneLast4,
  freeText: b.freeText,
})

/**
 * Replay one event onto a snapshot. The discriminated union exhaustive
 * matcher ensures every event variant is handled; if an event is
 * applied to a snapshot in an inappropriate state (e.g. Confirmed
 * event arrives at a Cancelled snapshot), the event is treated as a
 * no-op so replay never crashes mid-stream.
 */
export const applyEvent = (snapshot: Booking, event: BookingEvent): Booking =>
  Match.value(event).pipe(
    Match.discriminator("type")("Held", () => snapshot), // Held event is the seed; never replayed onto an existing snapshot
    Match.discriminator("type")("Confirmed", (ev): Booking => {
      if (snapshot.state !== "Held") return snapshot
      const next: Confirmed = {
        ...common(snapshot),
        state: "Confirmed",
        confirmedAt: ev.at,
      }
      return next
    }),
    Match.discriminator("type")("Cancelled", (ev): Booking => {
      if (snapshot.state !== "Held" && snapshot.state !== "Confirmed") return snapshot
      const next: Cancelled = {
        ...common(snapshot),
        state: "Cancelled",
        cancelledAt: ev.at,
        reason: ev.reason,
        cancelledBy: ev.by,
      }
      return next
    }),
    Match.discriminator("type")("Rescheduled", (ev): Booking => {
      if (snapshot.state !== "Confirmed") return snapshot
      const next: Confirmed = {
        ...common(snapshot),
        slot: ev.to,
        state: "Confirmed",
        confirmedAt: snapshot.confirmedAt,
      }
      return next
    }),
    Match.discriminator("type")("Completed", (ev): Booking => {
      if (snapshot.state !== "Confirmed") return snapshot
      const next: Completed = {
        ...common(snapshot),
        state: "Completed",
        completedAt: ev.at,
      }
      return next
    }),
    Match.discriminator("type")("NoShow", (ev): Booking => {
      if (snapshot.state !== "Confirmed") return snapshot
      const next: NoShow = {
        ...common(snapshot),
        state: "NoShow",
        markedAt: ev.at,
        markedBy: ev.by,
      }
      return next
    }),
    Match.exhaustive,
  )

/**
 * Replay an event stream from a `Held` seed. The seed event must be
 * present (it carries the bookingCode + slot + service identity), and
 * subsequent events are folded in order.
 */
export const replay = (seed: Held, events: readonly BookingEvent[]): Booking =>
  events.reduce<Booking>((snap, ev) => applyEvent(snap, ev), seed)
