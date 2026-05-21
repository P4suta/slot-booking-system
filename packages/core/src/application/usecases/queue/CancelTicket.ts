import { Effect } from "effect"
import type { ConcurrencyError, DomainError, StorageError } from "../../../domain/errors/Errors.js"
import type { Actor, Ticket } from "../../../domain/queue/Ticket.js"
import { applyCancel, guardActive, invalidTransition } from "../../../domain/queue/transitions.js"
import type { TicketId } from "../../../domain/types/EntityId.js"
import type { CustomerHandle } from "../../../domain/value-objects/CustomerHandle.js"
import type { Clock } from "../../ports/Clock.js"
import type { TicketRepository } from "../../ports/EventSourcedRepository.js"
import type { IdGenerator } from "../../ports/IdGenerator.js"
import type { Logger } from "../../ports/Logger.js"
import { authenticateCustomer, loadOrTicketNotFound } from "../_authenticate.js"
import { applyAndPersist } from "../_withUseCaseEnv.js"

/**
 * CancelTicket — `Waiting | Called | Overdue → Cancelled` (ADR-0071
 * swaps Serving for Overdue). Both customer (with handle) and staff
 * (no handle, capability already verified upstream) call into this
 * use case; the actor field records who. Overdue is allowed so a
 * customer who has stopped responding to nudges can still self-cancel,
 * and staff can invalidate a ticket when they learn out-of-band
 * that the customer is not coming.
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
    // `guardActive` short-circuits on the three terminal states
    // (Cancelled / Served / NoShow); the three remaining variants
    // (Waiting, Called, Overdue) are all accepted by `applyCancel`.
    // TypeScript can't narrow the union from the runtime
    // `guardActive` check alone, so a defensive state-tag re-check
    // feeds the narrowing required by `applyCancel`'s `Waiting |
    // Called | Overdue` input.
    /* v8 ignore next 7 */
    if (
      loaded.state.state !== "Waiting" &&
      loaded.state.state !== "Called" &&
      loaded.state.state !== "Overdue"
    ) {
      return yield* Effect.fail(invalidTransition(loaded.state.state, "Cancel"))
    }
    const cancellable = loaded.state
    return yield* applyAndPersist({
      loaded,
      apply: (at, eventId) => applyCancel(cancellable, at, eventId, actor, reason),
      log: {
        tag: "CancelTicket",
        code: "I_USECASE_CANCEL_TICKET",
        data: { ticketId, actor },
      },
    })
  })
