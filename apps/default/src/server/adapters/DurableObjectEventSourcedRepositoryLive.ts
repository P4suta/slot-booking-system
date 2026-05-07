import {
  AggregateNotFoundError,
  type Booking,
  type BookingEvent,
  BookingEventSchema,
  BookingEventSourcedRepository,
  type BookingId,
  BookingSchema,
  ConcurrencyError,
  StorageError,
} from "@booking/core"
import { max as drizzleMax, eq, sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/durable-sqlite"
import { Effect, Layer, Schema } from "effect"
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

const encodeBooking = Schema.encodeSync(BookingSchema)
const decodeBookingEither = Schema.decodeUnknownResult(BookingSchema)
const encodeEvent = Schema.encodeSync(BookingEventSchema)

/** Variant-aware row builder. Mirrors `D1BookingMirror.toRow`. */
const bookingToRow = (b: Booking): typeof bookings.$inferInsert => {
  const enc = encodeBooking(b)
  const base = {
    id: b.id,
    code: enc.code,
    state: b.state,
    serviceId: b.serviceId,
    providerId: b.providerId,
    resourceIds: enc.resourceIds,
    slotStart: enc.slot.start,
    slotEnd: enc.slot.end,
    source: b.source,
    nameKana: enc.nameKana,
    phoneLast4: enc.phoneLast4,
    freeText: enc.freeText ?? null,
  }
  switch (b.state) {
    case "Held":
      return { ...base, heldAt: b.heldAt.toString(), expiresAt: b.expiresAt.toString() }
    case "Confirmed":
      return { ...base, confirmedAt: b.confirmedAt.toString() }
    case "Cancelled":
      return {
        ...base,
        cancelledAt: b.cancelledAt.toString(),
        cancelledBy: b.cancelledBy,
        cancelReason: b.reason,
      }
    case "Completed":
      return { ...base, completedAt: b.completedAt.toString() }
    case "NoShow":
      return { ...base, markedAt: b.markedAt.toString(), markedBy: b.markedBy }
  }
}

/** Reverse: SQL row → `Booking`. Per-state required-column re-validation. */
const rowToBooking = (row: typeof bookings.$inferSelect): Booking | null => {
  if (row.nameKana === null || row.phoneLast4 === null) return null
  const common = {
    id: row.id,
    code: row.code,
    serviceId: row.serviceId,
    providerId: row.providerId,
    resourceIds: row.resourceIds,
    slot: { start: row.slotStart, end: row.slotEnd },
    source: row.source,
    nameKana: row.nameKana,
    phoneLast4: row.phoneLast4,
    freeText: row.freeText,
  }
  let candidate: unknown
  switch (row.state) {
    case "Held":
      if (row.heldAt === null || row.expiresAt === null) return null
      candidate = { ...common, state: "Held", heldAt: row.heldAt, expiresAt: row.expiresAt }
      break
    case "Confirmed":
      if (row.confirmedAt === null) return null
      candidate = { ...common, state: "Confirmed", confirmedAt: row.confirmedAt }
      break
    case "Cancelled":
      if (row.cancelledAt === null || row.cancelledBy === null || row.cancelReason === null)
        return null
      candidate = {
        ...common,
        state: "Cancelled",
        cancelledAt: row.cancelledAt,
        cancelledBy: row.cancelledBy,
        reason: row.cancelReason,
      }
      break
    case "Completed":
      if (row.completedAt === null) return null
      candidate = { ...common, state: "Completed", completedAt: row.completedAt }
      break
    case "NoShow":
      if (row.markedAt === null || row.markedBy === null) return null
      candidate = { ...common, state: "NoShow", markedAt: row.markedAt, markedBy: row.markedBy }
      break
  }
  const r = decodeBookingEither(candidate)
  return r._tag === "Success" ? r.success : null
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
