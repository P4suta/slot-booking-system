import { Context, type Effect } from "effect"
import type {
  AggregateNotFoundError,
  ConcurrencyError,
  StorageError,
} from "../../domain/errors/Errors.js"
import type { Ticket } from "../../domain/queue/Ticket.js"
import type { TicketEvent } from "../../domain/queue/TicketEvent.js"
import type { TicketId } from "../../domain/types/EntityId.js"
import type { CustomerHandle } from "../../domain/value-objects/CustomerHandle.js"

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
 *   3. `issue(id, events, next)` is the ticket-issue special case
 *      where there is no prior aggregate; the adapter treats it as
 *      `save(id, 0, events, next)` with extra integrity checks
 *      (e.g. monotonic seq + unique id).
 *   4. `saveBatch(updates)` is the multi-aggregate atomic save used
 *      by `CallBatch` (ADR-0065). The whole `updates` array is
 *      committed in one transaction; if any member's revision check
 *      fails (or any append fails) the entire batch is rolled back
 *      and `ConcurrencyError` carries the offending member's
 *      `(expected, actual)` pair.
 *   5. `findActiveByHandle(handle)` resolves the active-set primary
 *      key (ADR-0069). The pre-terminal set `{Waiting, Called,
 *      Serving}` is filtered on `(nameKana, phoneLast4)` for an
 *      O(log N) index lookup; the same method backs both the
 *      idempotent `IssueTicket` early-return and the customer
 *      recovery endpoint `GET /tickets/by-handle`.
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
    /**
     * Active-set lookup by handle (ADR-0069). Returns the **unique**
     * active ticket whose stored `(nameKana, phoneLast4)` matches the
     * supplied handle, or `null` if none. "Active" is the pre-terminal
     * set `{Waiting, Called, Serving}` — terminal states release the
     * handle for re-use. The adapter is free to back this with an
     * index (SQLite partial UNIQUE in the DO adapter) or a linear
     * scan (in-memory adapter); the contract is on uniqueness, not
     * implementation strategy. Used by both the idempotent
     * `IssueTicket` early-return and the `GET /tickets/by-handle`
     * customer recovery endpoint.
     */
    readonly findActiveByHandle: (
      handle: CustomerHandle,
    ) => Effect.Effect<Ticket | null, StorageError>
  }
>()("@booking/core/TicketRepository") {}
