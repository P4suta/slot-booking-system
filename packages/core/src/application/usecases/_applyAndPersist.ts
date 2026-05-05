import { Effect } from "effect"
import type { Booking } from "../../domain/booking/Booking.js"
import type { Command } from "../../domain/booking/Command.js"
import { apply } from "../../domain/booking/transitions.js"
import type { DomainError } from "../../domain/errors/Errors.js"
import type { BookingEvent } from "../../domain/events/BookingEvent.js"
import { BookingRepository } from "../ports/BookingRepository.js"
import { EventStore } from "../ports/EventStore.js"
import { IdGenerator } from "../ports/IdGenerator.js"

/**
 * The shared "transition" phase used by `ConfirmBooking`,
 * `CancelBooking`, `RescheduleBooking`. Folds:
 *   1. mint a fresh `BookingEventId`
 *   2. run the pure `apply(booking, command, eventId)` total transition
 *   3. on success, append the event (truth) and upsert the projection
 *      in lockstep — order matters: events first so a crash between
 *      the two writes still leaves the system consistent on next
 *      `replay`
 *
 * Returns the next snapshot + emitted event so callers can surface
 * both to the GraphQL response.
 */
export type TransitionResult = {
  readonly booking: Booking
  readonly event: BookingEvent
}

export const applyAndPersist = (
  booking: Booking,
  command: Command,
): Effect.Effect<TransitionResult, DomainError, IdGenerator | EventStore | BookingRepository> =>
  Effect.gen(function* () {
    const idgen = yield* IdGenerator
    const store = yield* EventStore
    const repo = yield* BookingRepository

    const eventId = yield* idgen.newBookingEventId
    const result = apply(booking, command, eventId)
    if (result._tag === "Left") return yield* Effect.fail(result.left)

    yield* store.appendEvent(result.right.event)
    yield* repo.upsert(result.right.booking)
    return result.right
  })
