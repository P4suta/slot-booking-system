import { Effect } from "effect"
import type { Booking } from "../../domain/booking/Booking.js"
import type { ConcurrencyError, DomainError, StorageError } from "../../domain/errors/Errors.js"
import type { TraceId } from "../../domain/errors/TraceId.js"
import type { BookingEvent } from "../../domain/events/BookingEvent.js"
import type { BookingCode } from "../../domain/value-objects/BookingCode.js"
import type { PhoneLast4 } from "../../domain/value-objects/PhoneLast4.js"
import type { Clock } from "../ports/Clock.js"
import type { BookingEventSourcedRepository } from "../ports/EventSourcedRepository.js"
import type { IdGenerator } from "../ports/IdGenerator.js"
import type { Logger } from "../ports/Logger.js"
import { tapTaggedError, withSpan } from "../runtime/Telemetry.js"
import { applyAndPersist } from "./_applyAndPersist.js"
import { authenticateCustomer } from "./_authenticate.js"
import { infoPayload } from "./_log.js"
import { useCaseEnv } from "./_withUseCaseEnv.js"

/**
 * Cancel a booking. Per ADR-0007 customers can cancel both `Held` and
 * `Confirmed` bookings. Reason is opaque to the domain (operator-facing
 * audit field); a deployment may surface a fixed dropdown at the UI
 * boundary, but the core never enumerates reasons.
 *
 * The `cancelledBy: Actor` field is `"customer"` when the request goes
 * through this self-service use case; staff cancellations route through
 * a separate `StaffCancelBooking` use case (Phase 1.x) that bypasses
 * the phone check.
 */
export type CancelBookingInput = {
  readonly code: BookingCode
  readonly phoneLast4: PhoneLast4
  readonly reason: string
  readonly traceId?: TraceId
}

export type CancelBookingResult = {
  readonly booking: Booking
  readonly event: BookingEvent
}

export const CancelBooking = (
  input: CancelBookingInput,
): Effect.Effect<
  CancelBookingResult,
  DomainError | ConcurrencyError | StorageError,
  Clock | IdGenerator | BookingEventSourcedRepository | Logger
> =>
  withSpan(
    "usecase.CancelBooking",
    { "usecase.input.bookingCode": input.code },
    tapTaggedError(cancelBookingBody(input)),
  )

const cancelBookingBody = (
  input: CancelBookingInput,
): Effect.Effect<
  CancelBookingResult,
  DomainError | ConcurrencyError | StorageError,
  Clock | IdGenerator | BookingEventSourcedRepository | Logger
> =>
  Effect.gen(function* () {
    const { clock, logger } = yield* useCaseEnv

    const loaded = yield* authenticateCustomer(input.code, input.phoneLast4)
    const at = yield* clock.nowInstant
    const result = yield* applyAndPersist(loaded.state.id, loaded, {
      kind: "Cancel",
      at,
      reason: input.reason,
      capability: {
        _tag: "CustomerCapability",
        bookingCode: input.code,
        phoneLast4: input.phoneLast4,
      },
    })

    yield* logger.info(
      infoPayload(
        "BookingCancelled",
        "I_USECASE_CANCEL",
        { bookingId: loaded.state.id },
        input.traceId,
      ),
    )

    return { booking: result.booking, event: result.event }
  })
