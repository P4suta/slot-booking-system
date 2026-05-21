import { Effect } from "effect"
import type { ConcurrencyError, DomainError, StorageError } from "../../../domain/errors/Errors.js"
import type { Actor, Ticket } from "../../../domain/queue/Ticket.js"
import {
  applyMarkNoShow,
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
 * MarkNoShow — `Called | Overdue → NoShow` (ADR-0072 broadens the
 * source). The alarm sweep fires from `Overdue` after `MAX_NUDGES`
 * nudges; staff may fire from either pre-terminal state.
 */
export const MarkNoShow = (
  ticketId: TicketId,
  actor: Actor = "staff",
): Effect.Effect<
  Ticket,
  DomainError | ConcurrencyError | StorageError,
  Clock | IdGenerator | TicketRepository | Logger
> =>
  Effect.gen(function* () {
    const loaded = yield* loadOrTicketNotFound(ticketId)
    const terminal = guardActive(loaded.state)
    if (terminal !== null) return yield* Effect.fail(terminal)
    if (loaded.state.state !== "Called" && loaded.state.state !== "Overdue") {
      return yield* Effect.fail(invalidTransition(loaded.state.state, "MarkNoShow"))
    }
    const source = loaded.state
    return yield* applyAndPersist({
      loaded,
      apply: (at, eventId) => applyMarkNoShow(source, at, eventId, actor),
      log: {
        tag: "MarkNoShow",
        code: "I_USECASE_MARK_NO_SHOW",
        data: { ticketId, actor },
      },
    })
  })
