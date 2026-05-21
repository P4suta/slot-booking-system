import { Effect } from "effect"
import type { ConcurrencyError, DomainError, StorageError } from "../../../domain/errors/Errors.js"
import type { Ticket } from "../../../domain/queue/Ticket.js"
import {
  applyMoveToOverdue,
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
 * MoveToOverdue — `Called → Overdue` (ADR-0072). System-only command
 * dispatched by the QueueShop alarm sweep when
 * `now - calledAt > OVERDUE_AFTER_CALLED_SECONDS`. The transition gates
 * the bounded nudge loop; only after `MAX_NUDGES` nudges does the
 * terminal `Overdue → NoShow` fire.
 *
 * The actor is hard-coded to `"system"` — staff have no path to fire
 * this manually; if they want to escalate they use MarkNoShow or
 * Cancel directly from Called.
 */
export const MoveToOverdue = (
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
    if (loaded.state.state !== "Called") {
      return yield* Effect.fail(invalidTransition(loaded.state.state, "MoveToOverdue"))
    }
    const called = loaded.state
    return yield* applyAndPersist({
      loaded,
      apply: (at, eventId) => applyMoveToOverdue(called, at, eventId, "system"),
      log: {
        tag: "MoveToOverdue",
        code: "I_USECASE_MOVE_TO_OVERDUE",
        data: { ticketId },
      },
    })
  })
