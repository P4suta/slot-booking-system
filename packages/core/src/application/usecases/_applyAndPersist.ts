import { Effect } from "effect"
import type { Booking } from "../../domain/booking/Booking.js"
import type { Command } from "../../domain/booking/Command.js"
import { apply } from "../../domain/booking/transitions.js"
import type {
  AggregateNotFoundError,
  ConcurrencyError,
  DomainError,
  StorageError,
} from "../../domain/errors/Errors.js"
import type { BookingEvent } from "../../domain/events/BookingEvent.js"
import type { BookingId } from "../../domain/types/EntityId.js"
import {
  BookingEventSourcedRepository,
  type LoadedAggregate,
} from "../ports/EventSourcedRepository.js"
import { IdGenerator } from "../ports/IdGenerator.js"

/**
 * The shared "transition" phase used by `ConfirmBooking`,
 * `CancelBooking`, `RescheduleBooking`. Folds:
 *
 *   1. mint a fresh `BookingEventId`
 *   2. run the pure `apply(state, command, eventId)` total transition
 *   3. atomically: append the event, refresh the snapshot, advance
 *      the revision counter (`save` does all three inside one storage
 *      transaction; ADR-0029 D3)
 *
 * The caller passes a `LoadedAggregate<Booking>` (typically from
 * `authenticateCustomer`) so the same revision the caller observed is
 * threaded into `save` as `expected` — optimistic-concurrency check.
 *
 * Returns the next snapshot + emitted event so callers can surface
 * both to the GraphQL response, plus the resulting revision for any
 * caller that wants to chain another `save` without re-reading.
 */
type TransitionResult = {
  readonly booking: Booking
  readonly event: BookingEvent
  readonly revision: number
}

export const applyAndPersist = (
  id: BookingId,
  loaded: LoadedAggregate<Booking>,
  command: Command,
): Effect.Effect<
  TransitionResult,
  DomainError | AggregateNotFoundError | ConcurrencyError | StorageError,
  IdGenerator | BookingEventSourcedRepository
> =>
  Effect.gen(function* () {
    const idgen = yield* IdGenerator
    const repo = yield* BookingEventSourcedRepository

    const eventId = yield* idgen.newBookingEventId
    const { booking, event } = yield* apply(loaded.state, command, eventId)

    const saved = yield* repo.save(id, loaded.revision, [event], booking)
    return { booking, event, revision: saved.revision }
  })
