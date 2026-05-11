import { Effect } from "effect"
import type { ConcurrencyError, DomainError, StorageError } from "../../../domain/errors/Errors.js"
import type { Actor, Ticket } from "../../../domain/queue/Ticket.js"
import { applyRecall, guardActive, invalidTransition } from "../../../domain/queue/transitions.js"
import type { TicketId } from "../../../domain/types/EntityId.js"
import type { Clock } from "../../ports/Clock.js"
import type { TicketRepository } from "../../ports/EventSourcedRepository.js"
import type { IdGenerator } from "../../ports/IdGenerator.js"
import type { Logger } from "../../ports/Logger.js"
import { loadOrTicketNotFound } from "../_authenticate.js"
import { applyAndPersist } from "../_withUseCaseEnv.js"

/**
 * Recall — Called | PendingNoShow → Waiting. Two callers:
 *   1. Staff-issued reversal of an accidental `CallNext`
 *      ("呼び出しを間違えた") on a Called ticket.
 *   2. Customer "遅れる" response on a PendingNoShow walk-in /
 *      priority ticket (ADR-0074): the customer chose to come back
 *      without a specific ETA, so the ticket returns to the lane
 *      head with its original `seq` preserved. (Reservation tickets
 *      go through `RescheduleTicket` instead — they need a new slot.)
 *
 * The audit-grade `Recalled` event is appended alongside the
 * original `Called` so the log records both the call and its
 * withdrawal — the UI says "なかったことに" but the event store
 * never lies.
 */
export const Recall = (
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
    if (loaded.state.state !== "Called" && loaded.state.state !== "PendingNoShow") {
      return yield* Effect.fail(invalidTransition(loaded.state.state, "Recall"))
    }
    const source = loaded.state
    return yield* applyAndPersist({
      loaded,
      apply: (at, eventId) => applyRecall(source, at, eventId, actor),
      log: { tag: "Recall", code: "I_USECASE_RECALL", data: { ticketId, actor } },
    })
  })
