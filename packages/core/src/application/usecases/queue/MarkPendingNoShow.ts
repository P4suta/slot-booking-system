import type { Effect } from "effect"
import type { ConcurrencyError, DomainError, StorageError } from "../../../domain/errors/Errors.js"
import type { Actor, Ticket } from "../../../domain/queue/Ticket.js"
import { applyMarkPendingNoShow } from "../../../domain/queue/transitions.js"
import type { TicketId } from "../../../domain/types/EntityId.js"
import type { Clock } from "../../ports/Clock.js"
import type { TicketRepository } from "../../ports/EventSourcedRepository.js"
import type { IdGenerator } from "../../ports/IdGenerator.js"
import type { Logger } from "../../ports/Logger.js"
import { runCommand } from "../_withUseCaseEnv.js"

/**
 * MarkPendingNoShow — Called → PendingNoShow (ADR-0074). The staff-
 * facing 「来なかった」 button: the ticket enters a grace window
 * during which the customer can choose 「遅れる」 (Recall for
 * walk-in/priority, Reschedule for reservation) or 「来ない」
 * (Cancel). The DO alarm sweeps any PendingNoShow whose `markedAt +
 * GRACE_TTL_MIN` has elapsed into terminal NoShow.
 */
export const MarkPendingNoShow = (
  ticketId: TicketId,
  actor: Actor = "staff",
): Effect.Effect<
  Ticket,
  DomainError | ConcurrencyError | StorageError,
  Clock | IdGenerator | TicketRepository | Logger
> =>
  runCommand({
    ticketId,
    command: "MarkPendingNoShow",
    from: "Called",
    apply: (source, at, eventId) => applyMarkPendingNoShow(source, at, eventId, actor),
    code: "I_USECASE_MARK_PENDING_NO_SHOW",
    data: { ticketId, actor },
  })
