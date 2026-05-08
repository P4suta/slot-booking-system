import { Effect } from "effect"
import type { ConcurrencyError, DomainError, StorageError } from "../../../domain/errors/Errors.js"
import type { Ticket } from "../../../domain/queue/Ticket.js"
import {
  applyMarkServed,
  guardActive,
  invalidTransition,
} from "../../../domain/queue/transitions.js"
import type { TicketId } from "../../../domain/types/EntityId.js"
import { Clock } from "../../ports/Clock.js"
import { TicketRepository } from "../../ports/EventSourcedRepository.js"
import { IdGenerator } from "../../ports/IdGenerator.js"
import { Logger } from "../../ports/Logger.js"
import { loadOrTicketNotFound } from "../_authenticate.js"
import { infoPayload } from "../_log.js"

/**
 * MarkServed — Called → Served. Staff-only command; the GraphQL
 * resolver upstream already enforces the `operate_queue` scope, so
 * the use case body trusts the caller and focuses on the state
 * machine.
 */
export const MarkServed = (
  ticketId: TicketId,
): Effect.Effect<
  Ticket,
  DomainError | ConcurrencyError | StorageError,
  Clock | IdGenerator | TicketRepository | Logger
> =>
  Effect.gen(function* () {
    const clock = yield* Clock
    const idgen = yield* IdGenerator
    const repo = yield* TicketRepository
    const logger = yield* Logger
    const loaded = yield* loadOrTicketNotFound(ticketId)
    const terminal = guardActive(loaded.state)
    if (terminal !== null) return yield* Effect.fail(terminal)
    if (loaded.state.state !== "Called") {
      return yield* Effect.fail(invalidTransition(loaded.state.state, "MarkServed"))
    }
    const eventId = yield* idgen.newTicketEventId
    const at = yield* clock.nowInstant
    const { ticket, event } = applyMarkServed(loaded.state, at, eventId)
    yield* repo.save(ticketId, loaded.revision, [event], ticket)
    yield* logger.info(infoPayload("MarkServed", "I_USECASE_MARK_SERVED", { ticketId }))
    return ticket
  })
