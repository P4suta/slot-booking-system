import { Effect } from "effect"
import type { ConcurrencyError, DomainError, StorageError } from "../../../domain/errors/Errors.js"
import type { Actor, Ticket } from "../../../domain/queue/Ticket.js"
import { applyCancel, guardActive, invalidTransition } from "../../../domain/queue/transitions.js"
import type { TicketId } from "../../../domain/types/EntityId.js"
import type { CustomerHandle } from "../../../domain/value-objects/CustomerHandle.js"
import { Clock } from "../../ports/Clock.js"
import { TicketRepository } from "../../ports/EventSourcedRepository.js"
import { IdGenerator } from "../../ports/IdGenerator.js"
import { Logger } from "../../ports/Logger.js"
import { authenticateCustomer, loadOrTicketNotFound } from "../_authenticate.js"
import { infoPayload } from "../_log.js"

/**
 * CancelTicket — Waiting | Called → Cancelled. Both customer (with
 * handle) and staff (no handle, capability already verified
 * upstream) call into this use case; the actor field records who.
 *
 * Customer path performs handle verification through
 * `authenticateCustomer`; staff path skips it and just loads.
 */
export const CancelTicket = (
  ticketId: TicketId,
  actor: Actor,
  reason: string,
  handle?: CustomerHandle,
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
    const loaded =
      handle !== undefined
        ? yield* authenticateCustomer(ticketId, handle)
        : yield* loadOrTicketNotFound(ticketId)
    const terminal = guardActive(loaded.state)
    if (terminal !== null) return yield* Effect.fail(terminal)
    if (loaded.state.state !== "Waiting" && loaded.state.state !== "Called") {
      return yield* Effect.fail(invalidTransition(loaded.state.state, "Cancel"))
    }
    const eventId = yield* idgen.newTicketEventId
    const at = yield* clock.nowInstant
    const r = applyCancel(loaded.state, at, eventId, actor, reason)
    if (r._tag === "Failure") return yield* Effect.fail(r.failure)
    yield* repo.save(ticketId, loaded.revision, [r.success.event], r.success.ticket)
    yield* logger.info(
      infoPayload("CancelTicket", "I_USECASE_CANCEL_TICKET", {
        ticketId,
        actor,
      }),
    )
    return r.success.ticket
  })
