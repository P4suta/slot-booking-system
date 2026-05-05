import { Effect, Layer, STM, TMap } from "effect"
import { BookingEventSourcedRepository } from "../../application/ports/EventSourcedRepository.js"
import type { Booking } from "../../domain/booking/Booking.js"
import { AggregateNotFoundError, ConcurrencyError } from "../../domain/errors/Errors.js"
import type { BookingEvent } from "../../domain/events/BookingEvent.js"
import type { BookingId } from "../../domain/types/EntityId.js"
import type { BookingCode } from "../../domain/value-objects/BookingCode.js"

/**
 * STM-backed in-memory {@link BookingEventSourcedRepository}. Three
 * transactional maps cooperate inside one runtime per layer instance:
 *
 *   - `events`    `TMap<BookingId, readonly BookingEvent[]>`
 *                 the source of truth (ADR-0024). Append-only;
 *                 revision = `events.length`.
 *   - `snapshots` `TMap<BookingId, Booking>`
 *                 the read-side projection. Refreshed on every save
 *                 (snapshot interval = 1, see ADR-0029 D1) so `load`
 *                 is O(1) — replay never needs to fold the entire log.
 *   - `byCode`    `TMap<BookingCode, BookingId>`
 *                 secondary index used by `findByKey`.
 *
 * STM gives the three updates atomicity: a concurrent reader can never
 * observe a state where the snapshot is bumped but the events log is
 * not, or vice versa. Optimistic concurrency on `save` is also done
 * inside the STM transaction (`expected` revision is compared against
 * `events.length` and the whole transaction retries — or fails with
 * `ConcurrencyError` — atomically).
 */

type EventLog = TMap.TMap<BookingId, readonly BookingEvent[]>
type SnapshotMap = TMap.TMap<BookingId, Booking>
type CodeIndex = TMap.TMap<BookingCode, BookingId>

const lookupRevision = (log: EventLog, id: BookingId): STM.STM<number> =>
  STM.map(TMap.get(log, id), (opt) => (opt._tag === "Some" ? opt.value.length : 0))

const loadSTM = (
  log: EventLog,
  snapshots: SnapshotMap,
  id: BookingId,
): STM.STM<{ readonly state: Booking; readonly revision: number }, AggregateNotFoundError> =>
  STM.flatMap(TMap.get(snapshots, id), (snap) => {
    if (snap._tag === "None") return STM.fail(new AggregateNotFoundError({}))
    return STM.map(lookupRevision(log, id), (revision) => ({
      state: snap.value,
      revision,
    }))
  })

const saveSTM = (
  log: EventLog,
  snapshots: SnapshotMap,
  byCode: CodeIndex,
  id: BookingId,
  expected: number,
  events: readonly BookingEvent[],
  next: Booking,
): STM.STM<{ readonly revision: number }, ConcurrencyError> =>
  STM.flatMap(lookupRevision(log, id), (current) => {
    if (current !== expected) {
      return STM.fail(new ConcurrencyError({ expected, actual: current }))
    }
    const appended = STM.flatMap(TMap.get(log, id), (existing) => {
      const merged: readonly BookingEvent[] =
        existing._tag === "Some" ? [...existing.value, ...events] : [...events]
      return TMap.set(log, id, merged)
    })
    const writeSnapshot = TMap.set(snapshots, id, next)
    const writeIndex = TMap.set(byCode, next.code, id)
    return STM.as(STM.zipRight(STM.zipRight(appended, writeSnapshot), writeIndex), {
      revision: current + events.length,
    })
  })

const findByKeySTM = (
  byCode: CodeIndex,
  code: BookingCode,
): STM.STM<BookingId, AggregateNotFoundError> =>
  STM.flatMap(TMap.get(byCode, code), (opt) =>
    opt._tag === "Some" ? STM.succeed(opt.value) : STM.fail(new AggregateNotFoundError({})),
  )

export const makeInMemoryEventSourcedBookingRepository =
  (): Layer.Layer<BookingEventSourcedRepository> =>
    Layer.effect(
      BookingEventSourcedRepository,
      Effect.gen(function* () {
        const events = yield* STM.commit(TMap.empty<BookingId, readonly BookingEvent[]>())
        const snapshots = yield* STM.commit(TMap.empty<BookingId, Booking>())
        const byCode = yield* STM.commit(TMap.empty<BookingCode, BookingId>())
        return BookingEventSourcedRepository.of({
          load: (id) => STM.commit(loadSTM(events, snapshots, id)),
          save: (id, expected, evs, next) =>
            STM.commit(saveSTM(events, snapshots, byCode, id, expected, evs, next)),
          findByKey: (code) => STM.commit(findByKeySTM(byCode, code)),
        })
      }),
    )

/** Convenience: a fresh, empty repository per test or per Effect runtime. */
export const InMemoryEventSourcedBookingRepositoryLive = makeInMemoryEventSourcedBookingRepository()

/* -------------------------------------------------------------------------- */
/* Inspection handle — used only by tests that need a peek at the log/snapshot */
/* state alongside the layer. The port itself never exposes these escape      */
/* hatches.                                                                   */
/* -------------------------------------------------------------------------- */

export type InMemoryEventSourcedHandle = {
  readonly layer: Layer.Layer<BookingEventSourcedRepository>
  readonly readEvents: Effect.Effect<ReadonlyMap<BookingId, readonly BookingEvent[]>>
  readonly readSnapshots: Effect.Effect<ReadonlyMap<BookingId, Booking>>
}

export const makeInMemoryEventSourcedHandle = (): Effect.Effect<InMemoryEventSourcedHandle> =>
  Effect.gen(function* () {
    const events = yield* STM.commit(TMap.empty<BookingId, readonly BookingEvent[]>())
    const snapshots = yield* STM.commit(TMap.empty<BookingId, Booking>())
    const byCode = yield* STM.commit(TMap.empty<BookingCode, BookingId>())
    const layer = Layer.succeed(
      BookingEventSourcedRepository,
      BookingEventSourcedRepository.of({
        load: (id) => STM.commit(loadSTM(events, snapshots, id)),
        save: (id, expected, evs, next) =>
          STM.commit(saveSTM(events, snapshots, byCode, id, expected, evs, next)),
        findByKey: (code) => STM.commit(findByKeySTM(byCode, code)),
      }),
    )
    return {
      layer,
      readEvents: STM.commit(TMap.toMap(events)),
      readSnapshots: STM.commit(TMap.toMap(snapshots)),
    }
  })
