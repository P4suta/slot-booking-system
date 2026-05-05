import {
  AggregateNotFoundError,
  type Booking,
  type BookingCode,
  type BookingEvent,
  BookingEventSchema,
  BookingEventSourcedRepository,
  type BookingId,
  BookingSchema,
  ConcurrencyError,
  StorageError,
} from "@booking/core"
import { Effect, Layer, Schema } from "effect"

/**
 * Cloudflare Durable Object's `state.storage` exposes a transactional
 * key-value store backed (in 2026) by per-object SQLite. The
 * event-sourced port is realised by four namespaces:
 *
 *   `b:<bookingId>`     → encoded `Booking` snapshot (read model)
 *   `c:<bookingCode>`   → `bookingId` (secondary index used by findByKey)
 *   `e:<bookingId>:<seq>` → encoded `BookingEvent` (the truth)
 *   `s:<bookingId>`     → current revision (= events.length)
 *
 * One `state.storage.transaction(...)` covers every write `save` makes,
 * so a concurrent reader can never observe the snapshot bumped before
 * the event log catches up — the same atomicity property the in-memory
 * STM adapter gives, expressed in DO storage terms.
 *
 * Encoding goes through `Schema.encodeSync(BookingSchema)`; the wire
 * shape is the schema's `Encoded` projection (ISO-8601 strings for
 * Temporal types) so a snapshot exported from the DO can be reloaded
 * by the in-memory layer for tests / migration replays.
 *
 * The `seq` counter is zero-padded to 10 digits inside the key so
 * `state.storage.list({ prefix: "e:<id>:" })` returns rows in numeric
 * order — needed by `loadAllEvents` for projection replay.
 */

export type DurableStorage = {
  readonly get: <T = unknown>(key: string) => Promise<T | undefined>
  readonly put: <T>(entries: Record<string, T>) => Promise<void>
  readonly delete: (key: string) => Promise<boolean>
  readonly list: <T = unknown>(options?: {
    prefix?: string
    limit?: number
  }) => Promise<Map<string, T>>
  readonly transaction: <A>(fn: (txn: DurableStorage) => Promise<A>) => Promise<A>
}

const bookingKey = (id: BookingId): string => `b:${id}`
const codeKey = (code: BookingCode): string => `c:${code}`
const seqKey = (id: BookingId): string => `s:${id}`
const eventKey = (id: BookingId, seq: number): string =>
  `e:${id}:${seq.toString().padStart(10, "0")}`

const encodeBooking = Schema.encodeSync(BookingSchema)
const decodeBookingEither = Schema.decodeUnknownEither(BookingSchema)
const encodeEvent = Schema.encodeSync(BookingEventSchema)
const decodeEventEither = Schema.decodeUnknownEither(BookingEventSchema)

const wrapStorage =
  (reason: string) =>
  <A>(eff: Effect.Effect<A>): Effect.Effect<A, StorageError> =>
    eff.pipe(
      Effect.catchAllDefect((d) => Effect.fail(new StorageError({ reason, meta: { cause: d } }))),
    )

/** Load every booking snapshot currently in storage. Used at DO cold start. */
export const loadAllBookings = (storage: DurableStorage): Promise<readonly Booking[]> =>
  storage.list({ prefix: "b:" }).then((entries) => {
    const out: Booking[] = []
    for (const [, raw] of entries) {
      const decoded = decodeBookingEither(raw)
      if (decoded._tag === "Right") out.push(decoded.right)
    }
    return out
  })

/** Read every event in the log, in (bookingId, seq) ascending order. */
export const loadAllEvents = async (storage: DurableStorage): Promise<readonly BookingEvent[]> => {
  const entries = await storage.list({ prefix: "e:" })
  const out: BookingEvent[] = []
  for (const [, raw] of entries) {
    const decoded = decodeEventEither(raw)
    if (decoded._tag === "Right") out.push(decoded.right)
  }
  return out
}

export const makeDurableObjectEventSourcedRepository = (
  storage: DurableStorage,
): Layer.Layer<BookingEventSourcedRepository> =>
  Layer.succeed(
    BookingEventSourcedRepository,
    BookingEventSourcedRepository.of({
      load: (id) => {
        const inner: Effect.Effect<
          { readonly state: Booking; readonly revision: number },
          AggregateNotFoundError | StorageError
        > = wrapStorage("DO snapshot load")(Effect.promise(() => storage.get(bookingKey(id)))).pipe(
          Effect.flatMap((raw) => {
            if (raw === undefined) {
              return Effect.fail<AggregateNotFoundError | StorageError>(
                new AggregateNotFoundError({}),
              )
            }
            const decoded = decodeBookingEither(raw)
            if (decoded._tag === "Left") {
              return Effect.fail<AggregateNotFoundError | StorageError>(
                new StorageError({
                  reason: "DO snapshot decode failed",
                  meta: { cause: decoded.left },
                }),
              )
            }
            const state = decoded.right
            return wrapStorage("DO seq read")(
              Effect.promise(() => storage.get<number>(seqKey(id))),
            ).pipe(Effect.map((revision) => ({ state, revision: revision ?? 0 })))
          }),
        )
        return inner
      },

      save: (id, expected, events, next) =>
        Effect.tryPromise({
          try: () =>
            storage.transaction(async (txn) => {
              const current = (await txn.get<number>(seqKey(id))) ?? 0
              if (current !== expected) {
                throw new ConcurrencyError({ expected, actual: current })
              }
              const writes: Record<string, unknown> = {
                [bookingKey(id)]: encodeBooking(next),
                [codeKey(next.code)]: id,
                [seqKey(id)]: current + events.length,
              }
              events.forEach((event, i) => {
                const seq = current + i + 1
                writes[eventKey(id, seq)] = encodeEvent(event)
              })
              await txn.put(writes)
              return { revision: current + events.length }
            }),
          catch: (e) => {
            if (e instanceof ConcurrencyError) return e
            return new StorageError({ reason: "DO save txn failed", meta: { cause: e } })
          },
        }),

      findByKey: (code) =>
        wrapStorage("DO findByKey")(
          Effect.promise(() => storage.get<BookingId>(codeKey(code))),
        ).pipe(
          Effect.flatMap((id) =>
            id === undefined ? Effect.fail(new AggregateNotFoundError({})) : Effect.succeed(id),
          ),
        ),
    }),
  )
