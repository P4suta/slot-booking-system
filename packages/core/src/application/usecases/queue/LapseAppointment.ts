import { Effect } from "effect"
import {
  AppointmentRequiredForReservationLaneError,
  type ConcurrencyError,
  type DomainError,
  LaneMismatchError,
  type StorageError,
} from "../../../domain/errors/Errors.js"
import type { Ticket } from "../../../domain/queue/Ticket.js"
import {
  applyLapseAppointment,
  guardActive,
  invalidTransition,
} from "../../../domain/queue/transitions.js"
import type { TicketId } from "../../../domain/types/EntityId.js"
import type { Clock } from "../../ports/Clock.js"
import type { TicketRepository } from "../../ports/EventSourcedRepository.js"
import type { IdGenerator } from "../../ports/IdGenerator.js"
import type { Logger } from "../../ports/Logger.js"
import { loadOrTicketNotFound } from "../_authenticate.js"
import { applyAndPersist } from "../_withUseCaseEnv.js"

/**
 * LapseAppointment — `Waiting → Cancelled (reason: "appointment_lapsed")`
 * with a typed `AppointmentLapsed` event for audit (ADR-0075).
 * System-only command dispatched by the QueueShop alarm sweep when a
 * reservation-lane Waiting ticket's `appointmentAt + grace < now`.
 *
 * Pre-conditions:
 *   - the ticket exists (TicketNotFound otherwise via loadOrTicketNotFound)
 *   - the ticket is Waiting (terminal → AlreadyCancelled via guardActive;
 *     other pre-terminal states → InvalidStateTransition)
 *   - the ticket is in the reservation lane (LaneMismatch otherwise)
 *   - the ticket has an `appointmentAt` (Appointment­RequiredFor… is
 *     defensive: the lane invariant ensures this for reservation tickets)
 *
 * The cadence check (`appointmentAt + grace < now`) is the alarm
 * sweep's responsibility; this use case trusts the dispatcher and
 * commits the transition.
 */
export const LapseAppointment = (
  ticketId: TicketId,
): Effect.Effect<
  Ticket,
  DomainError | ConcurrencyError | StorageError,
  Clock | IdGenerator | TicketRepository | Logger
> =>
  Effect.gen(function* () {
    const loaded = yield* loadOrTicketNotFound(ticketId)
    const terminal = guardActive(loaded.state)
    if (terminal !== null) return yield* Effect.fail(terminal)
    if (loaded.state.state !== "Waiting") {
      return yield* Effect.fail(invalidTransition(loaded.state.state, "LapseAppointment"))
    }
    const waiting = loaded.state
    if (waiting.lane !== "reservation") {
      return yield* Effect.fail(
        new LaneMismatchError({ ticketLane: waiting.lane, targetLane: "reservation" }),
      )
    }
    /* v8 ignore next 3 */
    if (waiting.appointmentAt === null) {
      return yield* Effect.fail(new AppointmentRequiredForReservationLaneError({}))
    }
    return yield* applyAndPersist({
      loaded,
      apply: (at, eventId) => applyLapseAppointment(waiting, at, eventId),
      log: {
        tag: "LapseAppointment",
        code: "I_USECASE_LAPSE_APPOINTMENT",
        data: { ticketId },
      },
    })
  })
