import { Context, type Effect } from "effect"
import type {
  AggregateNotFoundError,
  ConcurrencyError,
  StorageError,
} from "../../domain/errors/Errors.js"
import type { Ticket } from "../../domain/queue/Ticket.js"
import type { TicketEvent } from "../../domain/queue/TicketEvent.js"
import type { TicketId } from "../../domain/types/EntityId.js"

/**
 * A loaded aggregate snapshot together with the monotonic event count
 * folded into it. `revision` is what the caller passes back to `save`
 * as `expected` to assert no concurrent writer mutated storage in the
 * interval between `load` and `save`.
 */
export type LoadedAggregate<A> = {
  readonly state: A
  readonly revision: number
}

/** Non-empty readonly array. */
export type NonEmptyReadonlyArray<T> = readonly [T, ...T[]]

/**
 * Event-sourced repository for the queue domain (ADR-0051). The
 * generic shape is `<A, I, E>`:
 *   - `A`: aggregate state (`Ticket`)
 *   - `I`: aggregate identifier (`TicketId`)
 *   - `E`: event variant (`TicketEvent`)
 *
 * Phase 1 of the queue pivot specialises the port at the Ticket
 * shape; the slot-graph's generic three-parameter contract collapses
 * to a single instance because the queue has exactly one aggregate.
 *
 * Contract:
 *   1. `load(id)` returns the latest folded state plus its revision,
 *      or `AggregateNotFoundError` when storage has no record.
 *   2. `save(id, expected, events, next)` atomically:
 *        - asserts current revision == `expected` (else `ConcurrencyError`)
 *        - appends `events` in order (revision increases by `events.length`)
 *        - persists `next` as the snapshot
 *        - enqueues the events to any side-channel the adapter manages
 *      All four happen inside a single storage transaction.
 *   3. `findByHandle(ticketId)` is the secondary-index lookup the
 *      customer self-service flow uses (`(ticketId, nameKana,
 *      phoneLast4)`). The auth helper combines this with the handle
 *      mismatch check to surface `PhoneMismatchError`.
 *   4. `appendIssue(events, next)` is the ticket-issue special case
 *      where there is no prior aggregate; the adapter treats it as
 *      `save(id, 0, events, next)` with extra integrity checks
 *      (e.g. monotonic seq + unique id).
 */
export class TicketRepository extends Context.Service<
  TicketRepository,
  {
    readonly load: (
      id: TicketId,
    ) => Effect.Effect<LoadedAggregate<Ticket>, AggregateNotFoundError | StorageError>
    readonly save: (
      id: TicketId,
      expected: number,
      events: NonEmptyReadonlyArray<TicketEvent>,
      next: Ticket,
    ) => Effect.Effect<void, ConcurrencyError | StorageError>
    readonly issue: (
      id: TicketId,
      events: NonEmptyReadonlyArray<TicketEvent>,
      next: Ticket,
    ) => Effect.Effect<void, ConcurrencyError | StorageError>
    readonly nextSeq: () => Effect.Effect<number, StorageError>
    readonly listAll: () => Effect.Effect<readonly Ticket[], StorageError>
  }
>()("@booking/core/TicketRepository") {}
