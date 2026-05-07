import { Match } from "effect"
import type {
  BookingCommon,
  Cancelled,
  Completed,
  Confirmed,
  Held,
  NoShow,
} from "../booking/Booking.js"
import { confirmedSlotLens } from "../booking/optics.js"
import type { BookingEvent } from "../events/BookingEvent.js"
import { asView, type BookingView } from "./BookingView.js"

/**
 * Read-side projection over the booking event log (Step 15, ADR-0024
 * draft). Given a view and one event, return the next view; `replay`
 * folds an entire event stream back into the current view.
 *
 * Phase 0.7-α4 lifts this module out of `domain/booking/` into
 * `domain/read/` to mark the CQRS seam: the write side (`apply` in
 * `domain/booking/transitions.ts`) returns a fresh `Booking` aggregate
 * suitable for the next transition; the read side returns a
 * {@link BookingView} suitable for queries / mirrors / audit. The
 * alias is structural today; future phases may brand it.
 *
 * `applyEvent(view, event)` and `apply(snapshot, command)` agree on
 * the resulting structure when the event was the one apply emitted —
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
 * Replay one event onto a view. The discriminated union exhaustive
 * matcher ensures every event variant is handled; if an event is
 * applied to a view in an inappropriate state (e.g. Confirmed event
 * arrives at a Cancelled view), the event is treated as a no-op so
 * replay never crashes mid-stream.
 */
export const applyEvent = (view: BookingView, event: BookingEvent): BookingView =>
  Match.value(event).pipe(
    Match.discriminator("type")("Held", () => view), // Held event is the seed; never replayed onto an existing view
    Match.discriminator("type")("Confirmed", (ev): BookingView => {
      if (view.state !== "Held") return view
      const next: Confirmed = {
        ...common(view),
        state: "Confirmed",
        confirmedAt: ev.occurredAt,
      }
      return asView(next)
    }),
    Match.discriminator("type")("Cancelled", (ev): BookingView => {
      if (view.state !== "Held" && view.state !== "Confirmed") return view
      const next: Cancelled = {
        ...common(view),
        state: "Cancelled",
        cancelledAt: ev.occurredAt,
        reason: ev.reason,
        cancelledBy: ev.by,
      }
      return asView(next)
    }),
    Match.discriminator("type")("Rescheduled", (ev): BookingView => {
      if (view.state !== "Confirmed") return view
      return asView(confirmedSlotLens.replace(ev.to, view))
    }),
    Match.discriminator("type")("Completed", (ev): BookingView => {
      if (view.state !== "Confirmed") return view
      const next: Completed = {
        ...common(view),
        state: "Completed",
        completedAt: ev.occurredAt,
      }
      return asView(next)
    }),
    Match.discriminator("type")("NoShow", (ev): BookingView => {
      if (view.state !== "Confirmed") return view
      const next: NoShow = {
        ...common(view),
        state: "NoShow",
        markedAt: ev.occurredAt,
        markedBy: ev.by,
      }
      return asView(next)
    }),
    Match.exhaustive,
  )

/* -------------------------------------------------------------------------- */
/* Profunctor wrapper                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Profunctor wrapper around the booking event-fold.
 * `Projection<E, V>` is a `(seed: Held, events: readonly E[]) → V`
 * morphism with two variances:
 *
 *   - **contravariant input** (`lmap` / left of `dimap`): pre-compose
 *     a per-event upcaster `Upcaster<E', E>` so a legacy v_n event
 *     stream feeds the same fold as the latest-version stream;
 *   - **covariant output** (`rmap` / right of `dimap`): post-compose
 *     a serialiser `BookingView → DTO` for the GraphQL / OpenAPI /
 *     audit emit paths to share the read body.
 *
 * Profunctor laws (cross-validated by `projection.test.ts`):
 *   - identity:    `dimap(p, x⇒x, x⇒x) ≡ p`
 *   - composition: `dimap(p, f1 ∘ f2, g2 ∘ g1) ≡
 *                   dimap(dimap(p, f1, g1), f2, g2)`
 */
export type Projection<E, V> = {
  readonly run: (seed: Held, events: readonly E[]) => V
}

/** Smart constructor — wraps a fold function as a Projection. */
export const makeProjection = <E, V>(
  run: (seed: Held, events: readonly E[]) => V,
): Projection<E, V> => ({ run })

/** Contravariant input map. Pre-composes a per-event transformation. */
export const lmap = <E, E2, V>(p: Projection<E, V>, f: (e: E2) => E): Projection<E2, V> => ({
  run: (seed, events) => p.run(seed, events.map(f)),
})

/** Covariant output map. Post-composes a result transformation. */
export const rmap = <E, V, V2>(p: Projection<E, V>, g: (v: V) => V2): Projection<E, V2> => ({
  run: (seed, events) => g(p.run(seed, events)),
})

/** Bifunctorial map — both directions in one call. */
export const dimap = <E, E2, V, V2>(
  p: Projection<E, V>,
  f: (e: E2) => E,
  g: (v: V) => V2,
): Projection<E2, V2> => ({
  run: (seed, events) => g(p.run(seed, events.map(f))),
})

/**
 * Canonical booking projection. The runtime fold delegates to
 * {@link applyEvent} — this profunctor instance is the named entry
 * point GraphQL / audit / OpenAPI emitters reach for when they need a
 * `Projection<E, V>` value to compose with `dimap`.
 */
export const bookingProjection: Projection<BookingEvent, BookingView> = makeProjection(
  (seed, events) => events.reduce<BookingView>((view, ev) => applyEvent(view, ev), asView(seed)),
)
