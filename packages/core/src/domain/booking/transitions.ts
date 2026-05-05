import { Either, Match } from "effect"
import {
  AlreadyCancelledError,
  AlreadyCompletedError,
  AlreadyNoShowError,
  type DomainError,
  InvalidStateTransitionError,
} from "../errors/Errors.js"
import type { BookingEvent } from "../events/BookingEvent.js"
import type { BookingEventId } from "../types/EntityId.js"
import type {
  Booking,
  BookingCommon,
  Cancelled,
  Completed,
  Confirmed,
  Held,
  NoShow,
} from "./Booking.js"
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

/* -------------------------------------------------------------------------- */
/* Right-side smart constructors — the "data declaration" half of each       */
/* (state, command) row. Each returns the next booking + its event in lockstep.*/
/* -------------------------------------------------------------------------- */

const ok = (booking: Booking, event: BookingEvent): Either.Either<ApplyResult, DomainError> =>
  Either.right({ booking, event })

const okConfirm = (held: Held, at: Command["at"], eventId: BookingEventId) => {
  const next: Confirmed = { ...common(held), state: "Confirmed", confirmedAt: at }
  const event: BookingEvent = {
    id: eventId,
    type: "Confirmed",
    bookingId: held.id,
    at,
  }
  return ok(next, event)
}

const okCancel = (
  source: Held | Confirmed,
  at: Command["at"],
  reason: string,
  by: Cancelled["cancelledBy"],
  eventId: BookingEventId,
) => {
  const next: Cancelled = {
    ...common(source),
    state: "Cancelled",
    cancelledAt: at,
    reason,
    cancelledBy: by,
  }
  const event: BookingEvent = {
    id: eventId,
    type: "Cancelled",
    bookingId: source.id,
    at,
    reason,
    by,
  }
  return ok(next, event)
}

const okReschedule = (
  confirmed: Confirmed,
  at: Command["at"],
  newSlot: Confirmed["slot"],
  eventId: BookingEventId,
) => {
  const next: Confirmed = {
    ...common(confirmed),
    slot: newSlot,
    state: "Confirmed",
    confirmedAt: confirmed.confirmedAt,
  }
  const event: BookingEvent = {
    id: eventId,
    type: "Rescheduled",
    bookingId: confirmed.id,
    from: confirmed.slot,
    to: newSlot,
    at,
  }
  return ok(next, event)
}

const okComplete = (confirmed: Confirmed, at: Command["at"], eventId: BookingEventId) => {
  const next: Completed = { ...common(confirmed), state: "Completed", completedAt: at }
  const event: BookingEvent = {
    id: eventId,
    type: "Completed",
    bookingId: confirmed.id,
    at,
  }
  return ok(next, event)
}

const okNoShow = (
  confirmed: Confirmed,
  at: Command["at"],
  by: NoShow["markedBy"],
  eventId: BookingEventId,
) => {
  const next: NoShow = { ...common(confirmed), state: "NoShow", markedAt: at, markedBy: by }
  const event: BookingEvent = {
    id: eventId,
    type: "NoShow",
    bookingId: confirmed.id,
    at,
    by,
  }
  return ok(next, event)
}

const invalid = (
  from: Booking["state"],
  kind: Command["kind"],
): Either.Either<ApplyResult, DomainError> =>
  Either.left(new InvalidStateTransitionError({ from, command: kind }))

/* -------------------------------------------------------------------------- */
/* Per-state dispatch via Match.type / Match.discriminator                     */
/* -------------------------------------------------------------------------- */

const dispatchHeld = (held: Held, eventId: BookingEventId) =>
  Match.type<Command>().pipe(
    Match.discriminator("kind")("Confirm", (cmd) => okConfirm(held, cmd.at, eventId)),
    Match.discriminator("kind")("Cancel", (cmd) =>
      okCancel(held, cmd.at, cmd.reason, cmd.by, eventId),
    ),
    Match.discriminator("kind")("Expire", (cmd) =>
      okCancel(held, cmd.at, "hold expired", "system", eventId),
    ),
    Match.discriminator("kind")("Reschedule", () => invalid("Held", "Reschedule")),
    Match.discriminator("kind")("Complete", () => invalid("Held", "Complete")),
    Match.discriminator("kind")("MarkNoShow", () => invalid("Held", "MarkNoShow")),
    Match.exhaustive,
  )

const dispatchConfirmed = (confirmed: Confirmed, eventId: BookingEventId) =>
  Match.type<Command>().pipe(
    Match.discriminator("kind")("Cancel", (cmd) =>
      okCancel(confirmed, cmd.at, cmd.reason, cmd.by, eventId),
    ),
    Match.discriminator("kind")("Reschedule", (cmd) =>
      okReschedule(confirmed, cmd.at, cmd.newSlot, eventId),
    ),
    Match.discriminator("kind")("Complete", (cmd) => okComplete(confirmed, cmd.at, eventId)),
    Match.discriminator("kind")("MarkNoShow", (cmd) =>
      okNoShow(confirmed, cmd.at, cmd.by, eventId),
    ),
    Match.discriminator("kind")("Confirm", () => invalid("Confirmed", "Confirm")),
    Match.discriminator("kind")("Expire", () => invalid("Confirmed", "Expire")),
    Match.exhaustive,
  )

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Total state-transition function. `Match.value` over the booking's state
 * dispatches into a per-state `Match` over the command discriminator; every
 * reachable `(state, command)` pair is handled, and unreachable pairs return
 * `InvalidStateTransition` rather than throwing (ADR-0010, ADR-0013).
 *
 * Exhaustiveness is enforced at compile time by `Match.exhaustive` on both
 * the outer (state) and inner (command kind) dispatchers.
 *
 * `newEventId` is injected so callers can run with a deterministic
 * `IdGenerator` port in tests.
 */
export const apply = (
  booking: Booking,
  command: Command,
  newEventId: BookingEventId,
): Either.Either<ApplyResult, DomainError> =>
  Match.value(booking).pipe(
    Match.discriminator("state")("Held", (b) => dispatchHeld(b, newEventId)(command)),
    Match.discriminator("state")("Confirmed", (b) => dispatchConfirmed(b, newEventId)(command)),
    Match.discriminator("state")("Cancelled", () => Either.left(new AlreadyCancelledError({}))),
    Match.discriminator("state")("Completed", () => Either.left(new AlreadyCompletedError({}))),
    Match.discriminator("state")("NoShow", () => Either.left(new AlreadyNoShowError({}))),
    Match.exhaustive,
  )
