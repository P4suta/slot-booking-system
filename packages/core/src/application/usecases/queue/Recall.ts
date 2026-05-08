import { Effect } from "effect"
import type { ConcurrencyError, DomainError, StorageError } from "../../../domain/errors/Errors.js"
import type { Actor, Ticket } from "../../../domain/queue/Ticket.js"
import { applyRecall, guardActive, invalidTransition } from "../../../domain/queue/transitions.js"
import type { TicketId } from "../../../domain/types/EntityId.js"
import { Clock } from "../../ports/Clock.js"
import { TicketRepository } from "../../ports/EventSourcedRepository.js"
import { IdGenerator } from "../../ports/IdGenerator.js"
import { Logger } from "../../ports/Logger.js"
import { loadOrTicketNotFound } from "../_authenticate.js"
import { infoPayload } from "../_log.js"

/**
 * Recall — Called → Waiting. Staff-issued reversal of an accidental
 * `CallNext` ("呼び出しを間違えた"). The customer is returned to the
 * head of the queue with their original `seq` preserved, and an
 * audit-grade `Recalled` event is appended alongside the original
 * `Called` so the log records both the call and its withdrawal — the
 * UI says "なかったことに" but the event store never lies.
 *
 * Idempotency / safety: a non-`Called` source state (Waiting / Served
 * / NoShow / Cancelled) fails with `InvalidStateTransition`, so a
 * stale staff click after a colleague already moved the ticket on
 * surfaces a 409 rather than corrupting state.
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
    const clock = yield* Clock
    const idgen = yield* IdGenerator
    const repo = yield* TicketRepository
    const logger = yield* Logger
    const loaded = yield* loadOrTicketNotFound(ticketId)
    const terminal = guardActive(loaded.state)
    if (terminal !== null) return yield* Effect.fail(terminal)
    if (loaded.state.state !== "Called") {
      return yield* Effect.fail(invalidTransition(loaded.state.state, "Recall"))
    }
    const eventId = yield* idgen.newTicketEventId
    const at = yield* clock.nowInstant
    const { ticket, event } = applyRecall(loaded.state, at, eventId, actor)
    yield* repo.save(ticketId, loaded.revision, [event], ticket)
    yield* logger.info(infoPayload("Recall", "I_USECASE_RECALL", { ticketId, actor }))
    return ticket
  })
