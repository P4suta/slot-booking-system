import type { Effect } from "effect"
import type { ConcurrencyError, DomainError, StorageError } from "../../../domain/errors/Errors.js"
import type { Actor, Ticket } from "../../../domain/queue/Ticket.js"
import { applyMarkNoShow } from "../../../domain/queue/transitions.js"
import type { TicketId } from "../../../domain/types/EntityId.js"
import type { Clock } from "../../ports/Clock.js"
import type { TicketRepository } from "../../ports/EventSourcedRepository.js"
import type { IdGenerator } from "../../ports/IdGenerator.js"
import type { Logger } from "../../ports/Logger.js"
import { runCommand } from "../_withUseCaseEnv.js"

/**
 * MarkNoShow — Called | PendingNoShow → NoShow. Per ADR-0074 the
 * staff "来なかった" path goes through PendingNoShow first; this use
 * case is reached either by the DO alarm sweep when a
 * PendingNoShow's TTL elapses or by a system / admin override. The
 * actor field records who.
 */
export const MarkNoShow = (
  ticketId: TicketId,
  actor: Actor = "staff",
): Effect.Effect<
  Ticket,
  DomainError | ConcurrencyError | StorageError,
  Clock | IdGenerator | TicketRepository | Logger
> =>
  runCommand({
    ticketId,
    command: "MarkNoShow",
    from: ["Called", "PendingNoShow"],
    apply: (source, at, eventId) => applyMarkNoShow(source, at, eventId, actor),
    code: "I_USECASE_MARK_NO_SHOW",
    data: { ticketId, actor },
  })
