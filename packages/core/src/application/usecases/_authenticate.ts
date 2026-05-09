import { Effect } from "effect"
import {
  type DomainError,
  PhoneMismatchError,
  type StorageError,
  TicketNotFoundError,
} from "../../domain/errors/Errors.js"
import type { Ticket } from "../../domain/queue/Ticket.js"
import type { TicketId } from "../../domain/types/EntityId.js"
import type { CustomerHandle } from "../../domain/value-objects/CustomerHandle.js"
import { type LoadedAggregate, TicketRepository } from "../ports/EventSourcedRepository.js"

/**
 * Self-service authentication for customer mutations. The customer
 * presents `(ticketId, nameKana, phoneLast4)`; the helper:
 *
 *   1. Loads the ticket aggregate from the repository.
 *   2. Maps `AggregateNotFoundError` (storage miss) to the
 *      domain-level `TicketNotFoundError` so the customer-facing
 *      surface speaks one vocabulary.
 *   3. Verifies `(nameKana, phoneLast4)` against the stored fields;
 *      mismatch fails with `PhoneMismatchError`. The mismatch covers
 *      *either* component to defend against ticket-id enumeration
 *      that already knows one factor.
 *
 * Returns the {@link LoadedAggregate} so the caller can pass
 * `revision` into the next `save` and assert no concurrent writer
 * slipped in.
 */
export const authenticateCustomer = (
  ticketId: TicketId,
  handle: CustomerHandle,
): Effect.Effect<LoadedAggregate<Ticket>, DomainError | StorageError, TicketRepository> =>
  Effect.gen(function* () {
    const repo = yield* TicketRepository
    const loaded = yield* repo
      .load(ticketId)
      .pipe(
        Effect.catchTag("AggregateNotFound", () =>
          Effect.fail<DomainError>(new TicketNotFoundError({})),
        ),
      )
    const t = loaded.state
    if (
      (t.nameKana as string) !== (handle.nameKana as string) ||
      (t.phoneLast4 as string) !== (handle.phoneLast4 as string)
    ) {
      return yield* Effect.fail<DomainError>(new PhoneMismatchError({}))
    }
    return loaded
  })

/**
 * Surface a non-found ticket as `TicketNotFoundError` for staff
 * commands too. The staff dashboard already passes the id through;
 * this helper just retags the storage miss for consistent error
 * narration.
 */
export const loadOrTicketNotFound = (
  ticketId: TicketId,
): Effect.Effect<LoadedAggregate<Ticket>, DomainError | StorageError, TicketRepository> =>
  Effect.gen(function* () {
    const repo = yield* TicketRepository
    return yield* repo
      .load(ticketId)
      .pipe(
        Effect.catchTag("AggregateNotFound", () =>
          Effect.fail<DomainError>(new TicketNotFoundError({})),
        ),
      )
  })
