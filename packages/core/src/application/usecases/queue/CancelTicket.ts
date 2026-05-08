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
    // `yield* Effect.fail(...)` short-circuits the generator; V8
    // still instruments a phantom "yield* returned a value" branch
    // here that no input can exercise. Suppress just that artefact.
    /* v8 ignore next */
    if (terminal !== null) return yield* Effect.fail(terminal)
    // `guardActive` already short-circuits on the three terminal states
    // (Cancelled / Served / NoShow); the only remaining variants are
    // Waiting and Called, both of which `applyCancel` accepts. The
    // `invalidTransition` arm is therefore unreachable through the
    // current state lattice and exists only as a future-proof guard
    // should a non-terminal state be added without updating this body.
    /* v8 ignore next 3 */
    if (loaded.state.state !== "Waiting" && loaded.state.state !== "Called") {
      return yield* Effect.fail(invalidTransition(loaded.state.state, "Cancel"))
    }
    const eventId = yield* idgen.newTicketEventId
    const at = yield* clock.nowInstant
    const { ticket, event } = applyCancel(loaded.state, at, eventId, actor, reason)
    yield* repo.save(ticketId, loaded.revision, [event], ticket)
    yield* logger.info(
      infoPayload("CancelTicket", "I_USECASE_CANCEL_TICKET", {
        ticketId,
        actor,
      }),
    )
    return ticket
  })
