import { Either } from "effect"
import {
  AlreadyCancelledError,
  AlreadyCompletedError,
  AlreadyNoShowError,
  type DomainError,
  InvalidStateTransitionError,
} from "../errors/Errors.js"
import type { BookingEvent } from "../events/BookingEvent.js"
import type { BookingEventId } from "../types/EntityId.js"
import type { Booking, BookingCommon, Cancelled, Completed, Confirmed, NoShow } from "./Booking.js"
import type { Command } from "./Command.js"

export type ApplyResult = {
  readonly booking: Booking
  readonly event: BookingEvent
}

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
 * Total state-transition function. Pattern-matches on the booking's
 * current state and the incoming command together; every reachable
 * (state, command) pair is handled, and unreachable pairs return
 * `InvalidStateTransition` rather than throwing (ADR-0010, ADR-0013).
 *
 * Exhaustiveness over `Booking["state"]` is enforced at compile time
 * by the `_exhaustive: never` assignment in the outer default branch.
 *
 * `newEventId` is injected so callers can run with a deterministic
 * `IdGenerator` port in tests.
 */
export const apply = (
  booking: Booking,
  command: Command,
  newEventId: BookingEventId,
): Either.Either<ApplyResult, DomainError> => {
  switch (booking.state) {
    case "Held":
      return applyToHeld(booking, command, newEventId)
    case "Confirmed":
      return applyToConfirmed(booking, command, newEventId)
    case "Cancelled":
      return Either.left(new AlreadyCancelledError({}))
    case "Completed":
      return Either.left(new AlreadyCompletedError({}))
    case "NoShow":
      return Either.left(new AlreadyNoShowError({}))
  }
  // Exhaustiveness over `Booking["state"]` is enforced at the type level —
  // every variant returns above, so reaching here is unrepresentable. No
  // `default` branch and no `_exhaustive: never` is needed.
}

const applyToHeld = (
  booking: Booking & { state: "Held" },
  command: Command,
  newEventId: BookingEventId,
): Either.Either<ApplyResult, DomainError> => {
  switch (command.kind) {
    case "Confirm": {
      const next: Confirmed = {
        ...common(booking),
        state: "Confirmed",
        confirmedAt: command.at,
      }
      const event: BookingEvent = {
        id: newEventId,
        type: "Confirmed",
        bookingId: booking.id,
        at: command.at,
      }
      return Either.right({ booking: next, event })
    }
    case "Cancel": {
      const next: Cancelled = {
        ...common(booking),
        state: "Cancelled",
        cancelledAt: command.at,
        reason: command.reason,
        cancelledBy: command.by,
      }
      const event: BookingEvent = {
        id: newEventId,
        type: "Cancelled",
        bookingId: booking.id,
        at: command.at,
        reason: command.reason,
        by: command.by,
      }
      return Either.right({ booking: next, event })
    }
    case "Expire": {
      const next: Cancelled = {
        ...common(booking),
        state: "Cancelled",
        cancelledAt: command.at,
        reason: "hold expired",
        cancelledBy: "system",
      }
      const event: BookingEvent = {
        id: newEventId,
        type: "Cancelled",
        bookingId: booking.id,
        at: command.at,
        reason: "hold expired",
        by: "system",
      }
      return Either.right({ booking: next, event })
    }
    case "Reschedule":
    case "Complete":
    case "MarkNoShow":
      return Either.left(new InvalidStateTransitionError({ from: "Held", command: command.kind }))
  }
}

const applyToConfirmed = (
  booking: Booking & { state: "Confirmed" },
  command: Command,
  newEventId: BookingEventId,
): Either.Either<ApplyResult, DomainError> => {
  switch (command.kind) {
    case "Cancel": {
      const next: Cancelled = {
        ...common(booking),
        state: "Cancelled",
        cancelledAt: command.at,
        reason: command.reason,
        cancelledBy: command.by,
      }
      const event: BookingEvent = {
        id: newEventId,
        type: "Cancelled",
        bookingId: booking.id,
        at: command.at,
        reason: command.reason,
        by: command.by,
      }
      return Either.right({ booking: next, event })
    }
    case "Reschedule": {
      const oldSlot = booking.slot
      const next: Confirmed = {
        ...common(booking),
        slot: command.newSlot,
        state: "Confirmed",
        confirmedAt: booking.confirmedAt,
      }
      const event: BookingEvent = {
        id: newEventId,
        type: "Rescheduled",
        bookingId: booking.id,
        from: oldSlot,
        to: command.newSlot,
        at: command.at,
      }
      return Either.right({ booking: next, event })
    }
    case "Complete": {
      const next: Completed = {
        ...common(booking),
        state: "Completed",
        completedAt: command.at,
      }
      const event: BookingEvent = {
        id: newEventId,
        type: "Completed",
        bookingId: booking.id,
        at: command.at,
      }
      return Either.right({ booking: next, event })
    }
    case "MarkNoShow": {
      const next: NoShow = {
        ...common(booking),
        state: "NoShow",
        markedAt: command.at,
        markedBy: command.by,
      }
      const event: BookingEvent = {
        id: newEventId,
        type: "NoShow",
        bookingId: booking.id,
        at: command.at,
        by: command.by,
      }
      return Either.right({ booking: next, event })
    }
    case "Confirm":
    case "Expire":
      return Either.left(
        new InvalidStateTransitionError({ from: "Confirmed", command: command.kind }),
      )
  }
}
