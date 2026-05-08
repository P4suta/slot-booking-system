import { Effect } from "effect"
import type { Booking } from "../../domain/booking/Booking.js"
import type { ConcurrencyError, DomainError, StorageError } from "../../domain/errors/Errors.js"
import type { TraceId } from "../../domain/errors/TraceId.js"
import type { BookingEvent } from "../../domain/events/BookingEvent.js"
import type { BookingId } from "../../domain/types/EntityId.js"
import type { Clock } from "../ports/Clock.js"
import type { BookingEventSourcedRepository } from "../ports/EventSourcedRepository.js"
import type { IdGenerator } from "../ports/IdGenerator.js"
import type { Logger } from "../ports/Logger.js"
import { tapTaggedError, withSpan } from "../runtime/Telemetry.js"
import { applyAndPersist } from "./_applyAndPersist.js"
import { infoPayload } from "./_log.js"
import { useCaseEnv } from "./_withUseCaseEnv.js"

/**
 * System-driven expiry of a `Held` booking. Issued by the
 * `DaySchedule` Durable Object alarm when a hold's TTL has elapsed.
 *
 * Distinct from `CancelBooking`: this use case bypasses the customer
 * credential check (the customer is not present at expiry; the alarm
 * fires regardless), and the wire shape carries a `SystemCapability`
 * with `reason: "expire"` so the resulting `Cancelled` event is
 * audit-attributable to the system rather than the customer (Phase
 * 0.7-β1).
 */
export type ExpireBookingInput = {
  readonly bookingId: BookingId
  readonly traceId?: TraceId
}

export type ExpireBookingResult = {
  readonly booking: Booking
  readonly event: BookingEvent
}

export const ExpireBooking = (
  input: ExpireBookingInput,
): Effect.Effect<
  ExpireBookingResult,
  DomainError | ConcurrencyError | StorageError,
  Clock | IdGenerator | BookingEventSourcedRepository | Logger
> =>
  withSpan(
    "usecase.ExpireBooking",
    {
      "usecase.invocation.kind": "scheduled",
      "usecase.input.bookingId": input.bookingId,
    },
    tapTaggedError(expireBookingBody(input)),
  )

const expireBookingBody = (
  input: ExpireBookingInput,
): Effect.Effect<
  ExpireBookingResult,
  DomainError | ConcurrencyError | StorageError,
  Clock | IdGenerator | BookingEventSourcedRepository | Logger
> =>
  Effect.gen(function* () {
    const { clock, repo, logger } = yield* useCaseEnv

    const loaded = yield* repo.load(input.bookingId)
    const at = yield* clock.nowInstant
    const result = yield* applyAndPersist(input.bookingId, loaded, {
      kind: "Expire",
      at,
      capability: { _tag: "SystemCapability", reason: "expire" },
    })

    yield* logger.info(
      infoPayload(
        "BookingExpired",
        "I_USECASE_EXPIRE",
        { bookingId: input.bookingId },
        input.traceId,
      ),
    )

    return { booking: result.booking, event: result.event }
  })
