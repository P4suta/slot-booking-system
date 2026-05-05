import { Effect } from "effect"
import type { Booking } from "../../domain/booking/Booking.js"
import type { ConcurrencyError, DomainError, StorageError } from "../../domain/errors/Errors.js"
import type { TraceId } from "../../domain/errors/TraceId.js"
import type { BookingEvent } from "../../domain/events/BookingEvent.js"
import type { AvailableSlot } from "../../domain/slot/computeAvailableSlots.js"
import type { BookingCode } from "../../domain/value-objects/BookingCode.js"
import type { PhoneLast4 } from "../../domain/value-objects/PhoneLast4.js"
import type { BookingCodeIndex } from "../ports/BookingCodeIndex.js"
import { Clock } from "../ports/Clock.js"
import type { BookingEventSourcedRepository } from "../ports/EventSourcedRepository.js"
import type { IdGenerator } from "../ports/IdGenerator.js"
import { Logger } from "../ports/Logger.js"
import { applyAndPersist } from "./_applyAndPersist.js"
import { authenticateCustomer } from "./_authenticate.js"
import { infoPayload } from "./_log.js"

/**
 * Move a `Confirmed` booking to a different `AvailableSlot`. Same
 * capability discipline as `HoldSlot`: the `slot` argument must come
 * from `computeAvailableSlots`, so a customer cannot reschedule onto a
 * window that was never listed as available.
 *
 * The booking remains `Confirmed` after a successful reschedule;
 * `confirmedAt` is preserved and a `Rescheduled` event with `from` /
 * `to` slots is appended for the audit trail (ADR-0013).
 */
export type RescheduleBookingInput = {
  readonly code: BookingCode
  readonly phoneLast4: PhoneLast4
  readonly newSlot: AvailableSlot
  readonly traceId?: TraceId
}

export type RescheduleBookingResult = {
  readonly booking: Booking
  readonly event: BookingEvent
}

export const RescheduleBooking = (
  input: RescheduleBookingInput,
): Effect.Effect<
  RescheduleBookingResult,
  DomainError | ConcurrencyError | StorageError,
  Clock | IdGenerator | BookingEventSourcedRepository | BookingCodeIndex | Logger
> =>
  Effect.gen(function* () {
    const clock = yield* Clock
    const logger = yield* Logger

    const loaded = yield* authenticateCustomer(input.code, input.phoneLast4)
    const at = yield* clock.nowInstant
    const newSlotInstants = {
      start: input.newSlot.start.toInstant(),
      end: input.newSlot.end.toInstant(),
    }
    const result = yield* applyAndPersist(loaded.state.id, loaded, {
      kind: "Reschedule",
      at,
      newSlot: newSlotInstants,
    })

    yield* logger.info(
      infoPayload(
        "BookingRescheduled",
        "I_USECASE_RESCHEDULE",
        { bookingId: loaded.state.id },
        input.traceId,
      ),
    )

    return { booking: result.booking, event: result.event }
  })
