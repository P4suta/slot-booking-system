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
 * Single per-aggregate update bundle consumed by `saveBatch`. The
 * tuple `(id, expected, events, next)` mirrors the `save` arguments
 * so an adapter that understands `save` understands `saveBatch` as
 * the same contract repeated, **inside a single storage
 * transaction** so all updates land or none do (ADR-0065).
 */
export type BatchedSave = {
  readonly id: TicketId
  readonly expected: number
  readonly events: NonEmptyReadonlyArray<TicketEvent>
  readonly next: Ticket
}

/**
 * Event-sourced repository specialised at the queue's single aggregate
 * (ADR-0051). `Ticket` is the aggregate, `TicketId` the identifier,
 * `TicketEvent` the event variant.
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
 *   5. `saveBatch(updates)` is the multi-aggregate atomic save used
 *      by `CallBatch` (ADR-0065). The whole `updates` array is
 *      committed in one transaction; if any member's revision check
 *      fails (or any append fails) the entire batch is rolled back
 *      and `ConcurrencyError` carries the offending member's
 *      `(expected, actual)` pair.
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
    readonly saveBatch: (
      updates: NonEmptyReadonlyArray<BatchedSave>,
    ) => Effect.Effect<void, ConcurrencyError | StorageError>
    readonly nextSeq: () => Effect.Effect<number, StorageError>
    readonly listAll: () => Effect.Effect<readonly Ticket[], StorageError>
  }
>()("@booking/core/TicketRepository") {}
