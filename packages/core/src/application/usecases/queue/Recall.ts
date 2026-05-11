import type { Effect } from "effect"
import type { ConcurrencyError, DomainError, StorageError } from "../../../domain/errors/Errors.js"
import type { Actor, Ticket } from "../../../domain/queue/Ticket.js"
import { applyRecall } from "../../../domain/queue/transitions.js"
import type { TicketId } from "../../../domain/types/EntityId.js"
import type { Clock } from "../../ports/Clock.js"
import type { TicketRepository } from "../../ports/EventSourcedRepository.js"
import type { IdGenerator } from "../../ports/IdGenerator.js"
import type { Logger } from "../../ports/Logger.js"
import { runCommand } from "../_withUseCaseEnv.js"

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
 * The audit-grade `Recalled` event is appended alongside the original
 * `Called` so the log records both the call and its withdrawal — the
 * UI says "なかったことに" but the event store never lies.
 */
export const Recall = (
  ticketId: TicketId,
  actor: Actor = "staff",
): Effect.Effect<
  Ticket,
  DomainError | ConcurrencyError | StorageError,
  Clock | IdGenerator | TicketRepository | Logger
> =>
  runCommand({
    ticketId,
    command: "Recall",
    from: ["Called", "PendingNoShow"],
    apply: (source, at, eventId) => applyRecall(source, at, eventId, actor),
    code: "I_USECASE_RECALL",
    data: { ticketId, actor },
  })
