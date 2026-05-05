import { Context, type Effect } from "effect"
import type { Booking } from "../../domain/booking/Booking.js"
import type {
  AggregateNotFoundError,
  ConcurrencyError,
  StorageError,
} from "../../domain/errors/Errors.js"
import type { BookingEvent } from "../../domain/events/BookingEvent.js"
import type { BookingId } from "../../domain/types/EntityId.js"
import type { BookingCode } from "../../domain/value-objects/BookingCode.js"

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

/**
 * Non-empty readonly array. `save` rejects empty event lists at compile
 * time — there is no business reason to record "saved nothing".
 */
export type NonEmptyReadonlyArray<T> = readonly [T, ...T[]]

/**
 * Generic event-sourced repository capability.
 *
 *   - `A` aggregate state (e.g. `Booking`)
 *   - `I` aggregate identifier (e.g. `BookingId`)
 *   - `E` event variant (e.g. `BookingEvent`)
 *
 * The contract is:
 *
 *   1. `load(id)` returns the latest folded state plus its revision, or
 *      `AggregateNotFoundError` when storage has no record for `id`.
 *   2. `save(id, expected, events, next)` atomically:
 *        - asserts current revision == `expected` (else `ConcurrencyError`)
 *        - appends `events` in order (revision increases by `events.length`)
 *        - persists `next` as the snapshot
 *        - enqueues the events to any side-channel the adapter manages
 *          (e.g. a transactional outbox for downstream relay)
 *      All four happen inside a single storage transaction; partial
 *      success is impossible.
 *
 * The pure domain layer constructs `events` and `next` and asks the port
 * to make them durable. Snapshot strategy (interval, materialisation
 * format) is an adapter detail.
 *
 * See ADR-0028 (DO SQL storage) and ADR-0029 (event-sourced repository).
 */
export type EventSourcedRepositoryOps<A, I, E> = {
  readonly load: (id: I) => Effect.Effect<LoadedAggregate<A>, AggregateNotFoundError | StorageError>
  readonly save: (
    id: I,
    expected: number,
    events: NonEmptyReadonlyArray<E>,
    next: A,
  ) => Effect.Effect<{ readonly revision: number }, ConcurrencyError | StorageError>
}

/**
 * Optional secondary index. The booking aggregate needs lookup by user-
 * facing booking code (Crockford-32 string) before any domain reasoning
 * can run; other aggregates may not. Kept off the main interface so
 * generic usage stays minimal.
 */
export type SecondaryIndexOps<I, K> = {
  readonly findByKey: (key: K) => Effect.Effect<I, AggregateNotFoundError | StorageError>
}

/**
 * Booking-aggregate concretion: the single repository port the booking
 * use cases depend on. Replaces the legacy `BookingRepository` +
 * `EventStore` pair (Phase 0.5), which split the same write into two
 * non-atomic Promise calls.
 *
 * Production binds this to a Drizzle-backed adapter sharing the schema
 * between Cloudflare DO local SQLite and D1 (read-side mirror); tests
 * bind to an STM-backed in-memory fake.
 */
export class BookingEventSourcedRepository extends Context.Tag(
  "@booking/core/BookingEventSourcedRepository",
)<
  BookingEventSourcedRepository,
  EventSourcedRepositoryOps<Booking, BookingId, BookingEvent> &
    SecondaryIndexOps<BookingId, BookingCode>
>() {}
