import {
  AggregateNotFoundError,
  type Booking,
  type BookingEvent,
  BookingEventSchema,
  BookingEventSourcedRepository,
  BookingFromRow,
  type BookingId,
  ConcurrencyError,
  StorageError,
} from "@booking/core"
import { max as drizzleMax, eq, sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/durable-sqlite"
import { Effect, Layer, Result, Schema } from "effect"
import { bookingEvents, bookings, doTables, outbox } from "../schema/index.js"

/**
 * Cloudflare DO local SQLite is the truth for in-flight bookings
 * (ADR-0028). Drizzle's `durable-sqlite` driver wraps the runtime's
 * `state.storage.sql` API in a type-safe query builder; the schema
 * shared with D1 (`apps/default/src/server/schema/index.ts`) lets a
 * snapshot exported from one side reload on the other without
 * translation.
 *
 * Atomicity (ADR-0029 D3): `state.storage.transactionSync` covers the
 * write path of `save` so the four mutations
 *   1. revision check (`SELECT MAX(seq) FROM booking_events …`)
 *   2. event log append (`INSERT INTO booking_events …`)
 *   3. snapshot upsert (`INSERT … ON CONFLICT DO UPDATE`)
 *   4. outbox enqueue (`INSERT INTO outbox …`)
 * either all commit or none. Concurrent readers can never observe a
 * torn state, and the next outbox tick sees the freshly-enqueued rows.
 *
 * Optimistic concurrency: the `expected` revision the caller passes is
 * compared against `MAX(seq) WHERE booking_id = ?`. A mismatch raises
 * `ConcurrencyError` (`E_INF_CONCURRENCY`) and the whole transaction
 * aborts. DO's actor model serializes writes per-instance, so this is
 * a fail-safe rather than a hot contention point.
 *
 * Encoding: `Schema.encodeSync(BookingSchema)` and
 * `Schema.encodeSync(BookingEventSchema)` produce the wire shape
 * (ISO-8601 strings for Temporal) that Drizzle persists to text
 * columns; the variant timestamps are routed to per-state nullable
 * columns at the boundary (matches `BookingFromRow` ADR-0032).
 */

export type DurableObjectStorageLike = {
  readonly sql: SqlStorage
  readonly transactionSync: <T>(closure: () => T) => T
}

const encodeEvent = Schema.encodeSync(BookingEventSchema)
const decodeBookingFromRow = Schema.decodeUnknownResult(BookingFromRow)
const encodeBookingToRow = Schema.encodeSync(BookingFromRow)

/**
 * Variant-aware row codec lifted to the core `BookingFromRow` codec
 * (ADR-0032 + ADR-0036): the per-state row schema, per-state Domain
 * schema, and the slot ↔ (slotStart, slotEnd) overlay all live in
 * `packages/core/src/infrastructure/schema/BookingRow.ts`. The two
 * functions here are thin wrappers that adapt the codec to the
 * adapter's row-shape expectation; the per-state `switch` ladders
 * the previous implementation hand-rolled are gone.
 */
const bookingToRow = (b: Booking): typeof bookings.$inferInsert => {
  const encoded = encodeBookingToRow(b)
  const insert: typeof bookings.$inferInsert = {
    id: encoded.id,
    code: encoded.code,
    state: encoded.state,
    serviceId: encoded.serviceId,
    providerId: encoded.providerId,
    resourceIds: encoded.resourceIds,
    slotStart: encoded.slotStart.toString(),
    slotEnd: encoded.slotEnd.toString(),
    source: encoded.source,
    nameKana: encoded.nameKana,
    phoneLast4: encoded.phoneLast4,
    freeText: encoded.freeText,
  }
  switch (encoded.state) {
    case "Held":
      return {
        ...insert,
        heldAt: encoded.heldAt.toString(),
        expiresAt: encoded.expiresAt.toString(),
      }
    case "Confirmed":
      return { ...insert, confirmedAt: encoded.confirmedAt.toString() }
    case "Cancelled":
      return {
        ...insert,
        cancelledAt: encoded.cancelledAt.toString(),
        cancelledBy: encoded.cancelledBy,
        cancelReason: encoded.cancelReason,
      }
    case "Completed":
      return { ...insert, completedAt: encoded.completedAt.toString() }
    case "NoShow":
      return {
        ...insert,
        markedAt: encoded.markedAt.toString(),
        markedBy: encoded.markedBy,
      }
  }
}

/**
 * Reverse: SQL row → `Booking`. Delegates to the same codec via
 * `BookingFromRow.decode` — every per-state required-column check
 * happens inside the schema's `Schema.Union` arms, so a row whose
 * variant timestamps are missing fails the decode rather than the
 * caller restating each `null`-guard. Returns `null` so the
 * `loadAllBookings` consumer can drop a row whose PII has been
 * purged (the BookingFromRow rejects nullable PII).
 */
const rowToBooking = (row: typeof bookings.$inferSelect): Booking | null => {
  const decoded = decodeBookingFromRow(row)
  return Result.isSuccess(decoded) ? decoded.success : null
}

/**
 * Variant payload extractor for `booking_events.payload`. The base
 * fields (`id`, `bookingId`, `seq`, `version`, `type`, `occurred_at`,
 * `recorded_at`) live in dedicated columns; everything else lives in
 * the JSON `payload` blob.
 */
const eventPayload = (event: BookingEvent): Readonly<Record<string, unknown>> | null => {
  const enc = encodeEvent(event)
  const {
    id: _id,
    bookingId: _bid,
    version: _v,
    occurredAt: _oa,
    recordedAt: _ra,
    type: _t,
    ...rest
  } = enc as Record<string, unknown>
  void _id
  void _bid
  void _v
  void _oa
  void _ra
  void _t
  if (Object.keys(rest).length === 0) return null
  return rest
}

const eventToRow = (
  event: BookingEvent,
  seq: number,
  recordedAt: string,
): typeof bookingEvents.$inferInsert => {
  const enc = encodeEvent(event)
  return {
    id: enc.id,
    bookingId: enc.bookingId,
    seq,
    version: enc.version,
    type: enc.type,
    occurredAt: enc.occurredAt,
    recordedAt,
    payload: eventPayload(event),
  }
}

const wrapStorage =
  (reason: string) =>
  <A>(eff: Effect.Effect<A>): Effect.Effect<A, StorageError> =>
    eff.pipe(Effect.catchDefect((d) => Effect.fail(new StorageError({ reason, cause: d }))))

/** Load every booking snapshot currently in DO storage. Used by alarm()'s outbox drain. */
export const loadAllBookings = (storage: DurableObjectStorageLike): readonly Booking[] => {
  const db = drizzle(storage as unknown as DurableObjectStorage, { schema: doTables })
  const rows = db.select().from(bookings).all()
  const out: Booking[] = []
  for (const r of rows) {
    const decoded = rowToBooking(r)
    if (decoded !== null) out.push(decoded)
  }
  return out
}

export const makeDurableObjectEventSourcedRepository = (
  storage: DurableObjectStorageLike,
): Layer.Layer<BookingEventSourcedRepository> => {
  const db = drizzle(storage as unknown as DurableObjectStorage, { schema: doTables })

  return Layer.succeed(
    BookingEventSourcedRepository,
    BookingEventSourcedRepository.of({
      load: (id) =>
        wrapStorage("DO load")(
          Effect.sync(() => {
            const row = db.select().from(bookings).where(eq(bookings.id, id)).get()
            if (row === undefined) return null
            const booking = rowToBooking(row)
            if (booking === null) return null
            const seqRow = db
              .select({ maxSeq: drizzleMax(bookingEvents.seq) })
              .from(bookingEvents)
              .where(eq(bookingEvents.bookingId, id))
              .get()
            const revision = seqRow?.maxSeq ?? 0
            return { state: booking, revision }
          }),
        ).pipe(
          Effect.flatMap((opt) =>
            opt === null
              ? Effect.fail<AggregateNotFoundError | StorageError>(new AggregateNotFoundError({}))
              : Effect.succeed(opt),
          ),
        ),

      save: (id, expected, events, next) =>
        Effect.tryPromise({
          try: () =>
            Promise.resolve(
              storage.transactionSync(() => {
                /* 1. revision check */
                const seqRow = db
                  .select({ maxSeq: drizzleMax(bookingEvents.seq) })
                  .from(bookingEvents)
                  .where(eq(bookingEvents.bookingId, id))
                  .get()
                const current = seqRow?.maxSeq ?? 0
                if (current !== expected) {
                  throw new ConcurrencyError({ expected, actual: current })
                }

                const recordedAt = new Date().toISOString()
                const eventRows = events.map((event, i) =>
                  eventToRow(event, current + i + 1, recordedAt),
                )

                /* 2. event log append */
                db.insert(bookingEvents).values(eventRows).run()

                /* 3. snapshot upsert */
                const snapshotRow = bookingToRow(next)
                db.insert(bookings)
                  .values(snapshotRow)
                  .onConflictDoUpdate({
                    target: bookings.id,
                    set: {
                      ...snapshotRow,
                      updatedAt: sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
                    },
                  })
                  .run()

                /* 4. outbox enqueue (one row per event; snapshot is read
                 *    fresh from the bookings table at relay time, ADR-0029
                 *    revised by Phase 0.7-β5) */
                const outboxRows = events.map((event, i) => {
                  const seq = current + i + 1
                  const enc = encodeEvent(event)
                  return {
                    id: enc.id,
                    bookingId: enc.bookingId,
                    seq,
                    type: enc.type,
                    payload: enc,
                    enqueuedAt: recordedAt,
                    nextAttemptAt: recordedAt,
                    attempts: 0,
                    lastError: null,
                  }
                })
                db.insert(outbox).values(outboxRows).run()

                return { revision: current + events.length }
              }),
            ),
          catch: (e) => {
            if (e instanceof ConcurrencyError) return e
            return new StorageError({ reason: "DO save txn failed", cause: e })
          },
        }),

      findByKey: (code) =>
        wrapStorage("DO findByKey")(
          Effect.sync(() =>
            db.select({ id: bookings.id }).from(bookings).where(eq(bookings.code, code)).get(),
          ),
        ).pipe(
          Effect.flatMap((row) =>
            row === undefined
              ? Effect.fail<AggregateNotFoundError | StorageError>(new AggregateNotFoundError({}))
              : Effect.succeed(row.id as BookingId),
          ),
        ),
    }),
  )
}
