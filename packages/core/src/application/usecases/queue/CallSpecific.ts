import { Effect } from "effect"
import type { ConcurrencyError, DomainError, StorageError } from "../../../domain/errors/Errors.js"
import type { Actor, Ticket } from "../../../domain/queue/Ticket.js"
import { applyCall, guardActive, invalidTransition } from "../../../domain/queue/transitions.js"
import type { TicketId } from "../../../domain/types/EntityId.js"
import type { Clock } from "../../ports/Clock.js"
import type { TicketRepository } from "../../ports/EventSourcedRepository.js"
import type { IdGenerator } from "../../ports/IdGenerator.js"
import type { Logger } from "../../ports/Logger.js"
import { loadOrTicketNotFound } from "../_authenticate.js"
import { applyAndPersist } from "../_withUseCaseEnv.js"

/**
 * CallSpecific — call a specific Waiting ticket regardless of lane
 * head / FIFO position (ADR-0065). Sibling of {@link CallNext}; both
 * route through {@link applyCall}, but the entry point names the
 * intent in the audit log. Kept off the {@link runCommand} Kleisli
 * combinator only so the lane is logged alongside the ticket id;
 * everything else mirrors that template.
 */
export const CallSpecific = (
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
    if (loaded.state.state !== "Waiting") {
      return yield* Effect.fail(invalidTransition(loaded.state.state, "CallSpecific"))
    }
    const waiting = loaded.state
    return yield* applyAndPersist({
      loaded,
      apply: (at, eventId) => applyCall(waiting, { at, eventId, calledBy: actor }),
      log: {
        tag: "CallSpecific",
        code: "I_USECASE_CALL_SPECIFIC",
        data: { ticketId, lane: waiting.lane },
      },
    })
  })
