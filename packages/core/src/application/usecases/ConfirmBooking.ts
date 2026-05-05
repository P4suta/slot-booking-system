import { Effect } from "effect"
import type { Booking } from "../../domain/booking/Booking.js"
import type { ConcurrencyError, DomainError, StorageError } from "../../domain/errors/Errors.js"
import type { TraceId } from "../../domain/errors/TraceId.js"
import type { BookingEvent } from "../../domain/events/BookingEvent.js"
import type { BookingCode } from "../../domain/value-objects/BookingCode.js"
import type { PhoneLast4 } from "../../domain/value-objects/PhoneLast4.js"
import { Clock } from "../ports/Clock.js"
import type { BookingEventSourcedRepository } from "../ports/EventSourcedRepository.js"
import type { IdGenerator } from "../ports/IdGenerator.js"
import { Logger } from "../ports/Logger.js"
import { applyAndPersist } from "./_applyAndPersist.js"
import { authenticateCustomer } from "./_authenticate.js"
import { infoPayload } from "./_log.js"

/**
 * Promote a `Held` booking to `Confirmed`. Customer-self-service flow:
 * `BookingCode + PhoneLast4` are the only credentials.
 *
 * Refusal modes: AggregateNotFoundError (or PhoneMismatch),
 * AlreadyCancelledError / AlreadyCompletedError / AlreadyNoShowError if
 * the booking is in a terminal state, InvalidStateTransitionError if
 * the state-(command) pair has no transition, ConcurrencyError if a
 * parallel writer slipped in between authenticate and save.
 */
export type ConfirmBookingInput = {
  readonly code: BookingCode
  readonly phoneLast4: PhoneLast4
  readonly traceId?: TraceId
}

export type ConfirmBookingResult = {
  readonly booking: Booking
  readonly event: BookingEvent
}

export const ConfirmBooking = (
  input: ConfirmBookingInput,
): Effect.Effect<
  ConfirmBookingResult,
  DomainError | ConcurrencyError | StorageError,
  Clock | IdGenerator | BookingEventSourcedRepository | Logger
> =>
  Effect.gen(function* () {
    const clock = yield* Clock
    const logger = yield* Logger

    const loaded = yield* authenticateCustomer(input.code, input.phoneLast4)
    const at = yield* clock.nowInstant
    const result = yield* applyAndPersist(loaded.state.id, loaded, { kind: "Confirm", at })

    yield* logger.info(
      infoPayload(
        "BookingConfirmed",
        "I_USECASE_CONFIRM",
        { bookingId: loaded.state.id },
        input.traceId,
      ),
    )

    return { booking: result.booking, event: result.event }
  })
