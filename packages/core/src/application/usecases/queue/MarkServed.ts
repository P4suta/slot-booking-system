import type { Effect } from "effect"
import type { ConcurrencyError, DomainError, StorageError } from "../../../domain/errors/Errors.js"
import type { Ticket } from "../../../domain/queue/Ticket.js"
import { applyMarkServed } from "../../../domain/queue/transitions.js"
import type { TicketId } from "../../../domain/types/EntityId.js"
import type { Clock } from "../../ports/Clock.js"
import type { TicketRepository } from "../../ports/EventSourcedRepository.js"
import type { IdGenerator } from "../../ports/IdGenerator.js"
import type { Logger } from "../../ports/Logger.js"
import { runCommand } from "../_withUseCaseEnv.js"

/**
 * MarkServed — `Called → Served`. ADR-0073 dropped the explicit
 * Serving variant; the source state narrows to Called only and the
 * projection-time "対応中" hint is a Kanban-side derivation. Staff-
 * only command; the upstream resolver already enforces the
 * `operate_queue` scope. Refactored onto the {@link runCommand}
 * Kleisli combinator (ADR-0080) so the boilerplate around load +
 * guard + invalidTransition narrow lives in one place.
 */
export const MarkServed = (
  ticketId: TicketId,
): Effect.Effect<
  Ticket,
  DomainError | ConcurrencyError | StorageError,
  Clock | IdGenerator | TicketRepository | Logger
> =>
  runCommand({
    ticketId,
    command: "MarkServed",
    from: "Called",
    apply: (source, at, eventId) => applyMarkServed(source, at, eventId),
    code: "I_USECASE_MARK_SERVED",
    data: { ticketId },
  })
