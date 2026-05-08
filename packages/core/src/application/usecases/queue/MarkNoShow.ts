import { Effect } from "effect"
import type { ConcurrencyError, DomainError, StorageError } from "../../../domain/errors/Errors.js"
import type { Actor, Ticket } from "../../../domain/queue/Ticket.js"
import {
  applyMarkNoShow,
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
 * MarkNoShow — Called → NoShow. Triggered by staff (manual click)
 * or by the QueueShop alarm sweep when a Called ticket exceeds
 * `NO_SHOW_TIMEOUT_SECONDS` (Phase 2). The actor field records who.
 */
export const MarkNoShow = (
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
      return yield* Effect.fail(invalidTransition(loaded.state.state, "MarkNoShow"))
    }
    const eventId = yield* idgen.newTicketEventId
    const at = yield* clock.nowInstant
    const r = applyMarkNoShow(loaded.state, at, eventId, actor)
    if (r._tag === "Failure") return yield* Effect.fail(r.failure)
    yield* repo.save(ticketId, loaded.revision, [r.success.event], r.success.ticket)
    yield* logger.info(infoPayload("MarkNoShow", "I_USECASE_MARK_NO_SHOW", { ticketId, actor }))
    return r.success.ticket
  })
