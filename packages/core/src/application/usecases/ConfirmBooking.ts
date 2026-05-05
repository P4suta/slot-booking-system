import { Effect } from "effect"
import type { Booking } from "../../domain/booking/Booking.js"
import type { DomainError } from "../../domain/errors/Errors.js"
import type { TraceId } from "../../domain/errors/TraceId.js"
import type { BookingEvent } from "../../domain/events/BookingEvent.js"
import type { BookingCode } from "../../domain/value-objects/BookingCode.js"
import type { PhoneLast4 } from "../../domain/value-objects/PhoneLast4.js"
import type { BookingCodeIndex } from "../ports/BookingCodeIndex.js"
import type { BookingRepository } from "../ports/BookingRepository.js"
import { Clock } from "../ports/Clock.js"
import type { EventStore } from "../ports/EventStore.js"
import type { IdGenerator } from "../ports/IdGenerator.js"
import { Logger } from "../ports/Logger.js"
import { applyAndPersist } from "./_applyAndPersist.js"
import { authenticateCustomer } from "./_authenticate.js"
import { infoPayload } from "./_log.js"

/**
 * Promote a `Held` booking to `Confirmed`. Customer-self-service flow:
 * `BookingCode + PhoneLast4` are the only credentials.
 *
 * Refusal modes: BookingNotFoundError (or PhoneMismatch),
 * AlreadyCancelledError / AlreadyCompletedError / AlreadyNoShowError if
 * the booking is in a terminal state, InvalidStateTransitionError if
 * the state-(command) pair has no transition (e.g. confirming an
 * already Confirmed booking).
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
  DomainError,
  Clock | IdGenerator | BookingRepository | EventStore | BookingCodeIndex | Logger
> =>
  Effect.gen(function* () {
    const clock = yield* Clock
    const logger = yield* Logger

    const booking = yield* authenticateCustomer(input.code, input.phoneLast4)
    const at = yield* clock.nowInstant
    const result = yield* applyAndPersist(booking, { kind: "Confirm", at })

    yield* logger.info(
      infoPayload(
        "BookingConfirmed",
        "I_USECASE_CONFIRM",
        { bookingId: booking.id },
        input.traceId,
      ),
    )

    return result
  })
