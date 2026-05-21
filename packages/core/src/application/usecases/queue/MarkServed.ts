import { Effect } from "effect"
import type { ConcurrencyError, DomainError, StorageError } from "../../../domain/errors/Errors.js"
import type { Ticket } from "../../../domain/queue/Ticket.js"
import {
  applyMarkServed,
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
 * MarkServed — `Called | Overdue → Served` (ADR-0071/0072 swap the
 * source-state set: Serving is gone, Overdue is the late-arrival
 * recovery path). Staff-only command; the GraphQL resolver upstream
 * already enforces the `operate_queue` scope, so the use case body
 * trusts the caller and focuses on the state machine.
 */
export const MarkServed = (
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
    if (loaded.state.state !== "Called" && loaded.state.state !== "Overdue") {
      return yield* Effect.fail(invalidTransition(loaded.state.state, "MarkServed"))
    }
    const source = loaded.state
    return yield* applyAndPersist({
      loaded,
      apply: (at, eventId) => applyMarkServed(source, at, eventId),
      log: { tag: "MarkServed", code: "I_USECASE_MARK_SERVED", data: { ticketId } },
    })
  })
