import { Effect } from "effect"
import {
  AppointmentRequiredForReservationLaneError,
  CheckInTooEarlyError,
  type ConcurrencyError,
  type DomainError,
  InvalidStateTransitionError,
  type StorageError,
  TicketNotFoundError,
} from "../../../domain/errors/Errors.js"
import { applyCheckIn } from "../../../domain/queue/transitions.js"
import type { TicketId } from "../../../domain/types/EntityId.js"
import { Clock } from "../../ports/Clock.js"
import { TicketRepository } from "../../ports/EventSourcedRepository.js"
import type { IdGenerator } from "../../ports/IdGenerator.js"
import type { Logger } from "../../ports/Logger.js"
import { applyAndPersist } from "../_withUseCaseEnv.js"

/** Window in which a customer may check-in before their slot — ADR-0068. */
const CHECK_IN_WINDOW_MINUTES = 10

/**
 * CheckIn — ADR-0068 customer-side arrival audit.
 *
 * The customer's `/ticket` page surfaces a 「到着しました」 button once
 * `now ≥ appointmentAt - 10min`; tapping it fires this use case. The
 * transition is `Waiting → Waiting` with a `CheckedIn` event; the
 * aggregate gains `checkedInAt = now`.
 *
 * Pre-conditions:
 *   - the ticket exists (TicketNotFound otherwise)
 *   - the ticket is Waiting (InvalidStateTransition otherwise)
 *   - the ticket is in the reservation lane (AppointmentRequiredFor…
 *     because walk-ins are implicitly checked-in at issue time)
 *   - `now ≥ appointmentAt - 10min` (CheckInTooEarly otherwise; the
 *     UI hides the button before the window opens, this guard
 *     covers the API-direct call surface)
 */
export const CheckIn = (
  ticketId: TicketId,
): Effect.Effect<
  undefined,
  DomainError | ConcurrencyError | StorageError,
  Clock | IdGenerator | TicketRepository | Logger
> =>
  Effect.gen(function* () {
    const repo = yield* TicketRepository
    const clock = yield* Clock
    const loaded = yield* repo
      .load(ticketId)
      .pipe(
        Effect.catchTag("AggregateNotFound", () =>
          Effect.fail<DomainError>(new TicketNotFoundError({})),
        ),
      )
    if (loaded.state.state !== "Waiting") {
      return yield* Effect.fail(
        new InvalidStateTransitionError({ from: loaded.state.state, command: "CheckIn" }),
      )
    }
    const waiting = loaded.state
    if (waiting.appointmentAt === null) {
      return yield* Effect.fail(new AppointmentRequiredForReservationLaneError({}))
    }
    const now = yield* clock.nowInstant
    const earliest = waiting.appointmentAt.subtract({ minutes: CHECK_IN_WINDOW_MINUTES })
    if (now.epochMilliseconds < earliest.epochMilliseconds) {
      return yield* Effect.fail(
        new CheckInTooEarlyError({
          appointmentAt: String(waiting.appointmentAt),
          now: String(now),
        }),
      )
    }
    yield* applyAndPersist({
      loaded,
      apply: (at, eventId) => applyCheckIn(waiting, at, eventId, "customer"),
      log: {
        tag: "CheckIn",
        code: "I_USECASE_CHECK_IN",
        data: { ticketId },
      },
    })
    return undefined
  })
