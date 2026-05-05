import { Effect, Layer, STM, TMap } from "effect"
import { EventStore } from "../../application/ports/EventStore.js"
import type { BookingEvent } from "../../domain/events/BookingEvent.js"
import type { BookingId } from "../../domain/types/EntityId.js"

/**
 * STM-backed in-memory {@link EventStore}.
 *
 * Models the booking event log as a per-aggregate append-only sequence
 * (`TMap<BookingId, ReadonlyArray<BookingEvent>>`). The log is the
 * write-side source of truth (ADR-0024 draft); read models — the
 * `Booking` snapshot in `BookingRepository` — are projections of this
 * stream via `domain/booking/projection.ts#applyEvent`.
 *
 * Append uses STM so concurrent appenders for *different* aggregates
 * never block each other (TMap rows are independent), while appenders
 * for the *same* aggregate are linearised — preserving the per-stream
 * ordering invariant the outbox / projection both depend on.
 */

type EventLog = TMap.TMap<BookingId, readonly BookingEvent[]>

const appendSTM =
  (log: EventLog) =>
  (event: BookingEvent): STM.STM<void> =>
    STM.flatMap(TMap.get(log, event.bookingId), (existing) => {
      const next = existing._tag === "Some" ? [...existing.value, event] : [event]
      return TMap.set(log, event.bookingId, next)
    })

const layerOver = (log: EventLog): Layer.Layer<EventStore> =>
  Layer.succeed(
    EventStore,
    EventStore.of({
      appendEvent: (event) => STM.commit(appendSTM(log)(event)),
    }),
  )

export const makeInMemoryEventStore = (): Layer.Layer<EventStore> =>
  Layer.effect(
    EventStore,
    Effect.flatMap(STM.commit(TMap.empty<BookingId, readonly BookingEvent[]>()), (log) =>
      Effect.succeed(
        EventStore.of({
          appendEvent: (event) => STM.commit(appendSTM(log)(event)),
        }),
      ),
    ),
  )

export const InMemoryEventStoreLive = makeInMemoryEventStore()

/* -------------------------------------------------------------------------- */
/* Inspection helpers — only used by tests + the DurableObject snapshot path. */
/* The port itself stays append-only; reads happen via the read-model         */
/* repository, never directly against this store.                              */
/* -------------------------------------------------------------------------- */

export type InMemoryEventStoreHandle = {
  readonly layer: Layer.Layer<EventStore>
  readonly readAll: Effect.Effect<ReadonlyMap<BookingId, readonly BookingEvent[]>>
}

/**
 * Build a fresh in-memory event store layer together with a
 * read-only snapshot extractor that shares the underlying `TMap`.
 * Used by `replay()`-driven projection tests and the DurableObject
 * cold-start path; **never** export the reader through the public
 * `EventStore` port (that would defeat the append-only contract).
 */
export const makeInMemoryEventStoreWithReader = (): Effect.Effect<InMemoryEventStoreHandle> =>
  Effect.map(STM.commit(TMap.empty<BookingId, readonly BookingEvent[]>()), (log) => ({
    layer: layerOver(log),
    readAll: STM.commit(TMap.toMap(log)),
  }))
