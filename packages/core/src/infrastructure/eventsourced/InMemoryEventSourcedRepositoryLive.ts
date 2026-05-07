import { Effect, HashMap, Layer, Option, Ref } from "effect"
import { BookingEventSourcedRepository } from "../../application/ports/EventSourcedRepository.js"
import type { Booking } from "../../domain/booking/Booking.js"
import { AggregateNotFoundError, ConcurrencyError } from "../../domain/errors/Errors.js"
import type { BookingEvent } from "../../domain/events/BookingEvent.js"
import type { BookingId } from "../../domain/types/EntityId.js"
import type { BookingCode } from "../../domain/value-objects/BookingCode.js"

/**
 * Single-`Ref`-backed in-memory {@link BookingEventSourcedRepository}.
 * One `Ref<Store>` is the atomic boundary; every mutation funnels
 * through `Ref.update` (or `Ref.modify` when a return value is needed),
 * which guarantees no concurrent reader observes a half-applied write.
 *
 *   - `events`    `HashMap<BookingId, readonly BookingEvent[]>`
 *                 the source of truth (ADR-0024). Append-only;
 *                 revision = `events.length`.
 *   - `snapshots` `HashMap<BookingId, Booking>`
 *                 the read-side projection. Refreshed on every save
 *                 (snapshot interval = 1, ADR-0029 D1) so `load`
 *                 is O(1) — replay never folds the entire log.
 *   - `byCode`    `HashMap<BookingCode, BookingId>`
 *                 secondary index used by `findByKey`.
 *
 * Effect 4 removed STM; the unified `Ref<Store>` keeps the same
 * atomic-across-three-maps invariant by reducing the boundary to a
 * single immutable record. Optimistic concurrency on `save` is
 * resolved inside the Ref update closure: the closure inspects the
 * current revision and returns either the new store or signals a
 * `ConcurrencyError` via the modify channel.
 */

type Store = {
  readonly events: HashMap.HashMap<BookingId, readonly BookingEvent[]>
  readonly snapshots: HashMap.HashMap<BookingId, Booking>
  readonly byCode: HashMap.HashMap<BookingCode, BookingId>
}

const emptyStore = (): Store => ({
  events: HashMap.empty<BookingId, readonly BookingEvent[]>(),
  snapshots: HashMap.empty<BookingId, Booking>(),
  byCode: HashMap.empty<BookingCode, BookingId>(),
})

const revisionOf = (store: Store, id: BookingId): number =>
  Option.match(HashMap.get(store.events, id), {
    onNone: () => 0,
    onSome: (es) => es.length,
  })

const loadFromStore = (
  store: Store,
  id: BookingId,
): Effect.Effect<{ readonly state: Booking; readonly revision: number }, AggregateNotFoundError> =>
  Option.match(HashMap.get(store.snapshots, id), {
    onNone: () => Effect.fail(new AggregateNotFoundError({})),
    onSome: (state) => Effect.succeed({ state, revision: revisionOf(store, id) }),
  })

const tryAppend = (
  store: Store,
  id: BookingId,
  expected: number,
  events: readonly BookingEvent[],
  next: Booking,
): { readonly store: Store; readonly result: { readonly revision: number } } | ConcurrencyError => {
  const current = revisionOf(store, id)
  if (current !== expected) return new ConcurrencyError({ expected, actual: current })
  const merged: readonly BookingEvent[] = Option.match(HashMap.get(store.events, id), {
    onNone: () => [...events],
    onSome: (existing) => [...existing, ...events],
  })
  return {
    store: {
      events: HashMap.set(store.events, id, merged),
      snapshots: HashMap.set(store.snapshots, id, next),
      byCode: HashMap.set(store.byCode, next.code, id),
    },
    result: { revision: current + events.length },
  }
}

const findIdByKey = (
  store: Store,
  code: BookingCode,
): Effect.Effect<BookingId, AggregateNotFoundError> =>
  Option.match(HashMap.get(store.byCode, code), {
    onNone: () => Effect.fail(new AggregateNotFoundError({})),
    onSome: (id) => Effect.succeed(id),
  })

const wireRepository = (ref: Ref.Ref<Store>) =>
  BookingEventSourcedRepository.of({
    load: (id) => Effect.flatMap(Ref.get(ref), (store) => loadFromStore(store, id)),
    save: (id, expected, evs, next) =>
      Effect.flatten(
        Ref.modify(
          ref,
          (
            store,
          ): readonly [Effect.Effect<{ readonly revision: number }, ConcurrencyError>, Store] => {
            const outcome = tryAppend(store, id, expected, evs, next)
            if (outcome instanceof ConcurrencyError) return [Effect.fail(outcome), store]
            return [Effect.succeed(outcome.result), outcome.store]
          },
        ),
      ),
    findByKey: (code) => Effect.flatMap(Ref.get(ref), (store) => findIdByKey(store, code)),
  })

export const makeInMemoryEventSourcedBookingRepository =
  (): Layer.Layer<BookingEventSourcedRepository> =>
    Layer.effect(
      BookingEventSourcedRepository,
      Effect.gen(function* () {
        const ref = yield* Ref.make<Store>(emptyStore())
        return wireRepository(ref)
      }),
    )

/** Convenience: a fresh, empty repository per test or per Effect runtime. */
export const InMemoryEventSourcedBookingRepositoryLive = makeInMemoryEventSourcedBookingRepository()

/* -------------------------------------------------------------------------- */
/* Inspection handle — used only by tests that need a peek at the log/snapshot */
/* state alongside the layer. The port itself never exposes these escape      */
/* hatches.                                                                   */
/* -------------------------------------------------------------------------- */

const hashMapToMap = <K, V>(hm: HashMap.HashMap<K, V>): ReadonlyMap<K, V> => {
  const m = new Map<K, V>()
  for (const [k, v] of hm) m.set(k, v)
  return m
}

export type InMemoryEventSourcedHandle = {
  readonly layer: Layer.Layer<BookingEventSourcedRepository>
  readonly readEvents: Effect.Effect<ReadonlyMap<BookingId, readonly BookingEvent[]>>
  readonly readSnapshots: Effect.Effect<ReadonlyMap<BookingId, Booking>>
}

export const makeInMemoryEventSourcedHandle = (): Effect.Effect<InMemoryEventSourcedHandle> =>
  Effect.gen(function* () {
    const ref = yield* Ref.make<Store>(emptyStore())
    const layer = Layer.succeed(BookingEventSourcedRepository, wireRepository(ref))
    return {
      layer,
      readEvents: Effect.map(Ref.get(ref), (s) => hashMapToMap(s.events)),
      readSnapshots: Effect.map(Ref.get(ref), (s) => hashMapToMap(s.snapshots)),
    }
  })
