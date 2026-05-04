import { Context, type Effect } from "effect"
import type { BookingEvent } from "../../domain/events/BookingEvent.js"

/**
 * Append-only event log for the booking aggregate. Production binds this
 * to a per-aggregate Durable Object SQLite table; tests use an in-memory
 * append-only list.
 *
 * The store is the **source of truth** in the CQRS model defined by
 * Step 15: read models (current `Booking` snapshot) are derived from a
 * fold over the events. The repository in {@link BookingRepository} is a
 * cache of that fold.
 */
export class EventStore extends Context.Tag("@booking/core/EventStore")<
  EventStore,
  {
    readonly appendEvent: (event: BookingEvent) => Effect.Effect<void>
  }
>() {}
