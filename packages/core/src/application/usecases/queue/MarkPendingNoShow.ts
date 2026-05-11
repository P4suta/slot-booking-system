import { Effect } from "effect"
import type { ConcurrencyError, DomainError, StorageError } from "../../../domain/errors/Errors.js"
import type { Actor, Ticket } from "../../../domain/queue/Ticket.js"
import {
  applyMarkPendingNoShow,
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
 * MarkPendingNoShow — Called → PendingNoShow (ADR-0074). The
 * staff-facing 「来なかった」 button: the ticket enters a grace
 * window during which the customer can choose 「遅れる」 (Recall
 * for walk-in/priority, Reschedule for reservation) or 「来ない」
 * (Cancel). The DO alarm sweeps any PendingNoShow whose
 * `markedAt + GRACE_TTL_MIN` has elapsed into terminal NoShow.
 */
export const MarkPendingNoShow = (
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
    if (loaded.state.state !== "Called") {
      return yield* Effect.fail(invalidTransition(loaded.state.state, "MarkPendingNoShow"))
    }
    const called = loaded.state
    return yield* applyAndPersist({
      loaded,
      apply: (at, eventId) => applyMarkPendingNoShow(called, at, eventId, actor),
      log: {
        tag: "MarkPendingNoShow",
        code: "I_USECASE_MARK_PENDING_NO_SHOW",
        data: { ticketId, actor },
      },
    })
  })
