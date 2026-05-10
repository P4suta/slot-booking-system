import { Effect } from "effect"
import type { ConcurrencyError, DomainError, StorageError } from "../../../domain/errors/Errors.js"
import type { Actor, Ticket } from "../../../domain/queue/Ticket.js"
import {
  applyStartServing,
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
 * StartServing — `Called → Serving` (ADR-0063). Once the operator
 * fires this, the NoShow alarm sweep no longer applies to the
 * ticket; the ticket lives in `Serving` until `MarkServed` (or, in
 * unusual cases, `Cancel`).
 */
export const StartServing = (
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
      return yield* Effect.fail(invalidTransition(loaded.state.state, "StartServing"))
    }
    const called = loaded.state
    return yield* applyAndPersist({
      loaded,
      apply: (at, eventId) => applyStartServing(called, at, eventId, actor),
      log: { tag: "StartServing", code: "I_USECASE_START_SERVING", data: { ticketId } },
    })
  })
