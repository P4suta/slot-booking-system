import type { BookingCode, BookingId } from "@booking/core"
import { type Booking, BookingNotFoundError, BookingRepository, BookingSchema } from "@booking/core"
import { eq } from "drizzle-orm"
import { drizzle } from "drizzle-orm/d1"
import { Effect, Layer, Schema } from "effect"
import { bookings } from "../schema/bookings.js"

/**
 * Cloudflare D1 ↔ `BookingRepository` adapter.
 *
 * D1 is the long-retention read-side store (ADR-0006). Writes funnel
 * through the per-day {@link DaySchedule} DurableObject's outbox, so by
 * the time D1 sees a row it is already authoritative for that
 * `(deployment, date)` aggregate. This adapter does not need its own
 * concurrency control — the DO's actor model is the serialisation
 * primitive.
 *
 * Encoding goes through `Schema.encodeSync(BookingSchema)`: every
 * Temporal field becomes its ISO-8601 string, every branded primitive
 * becomes its underlying string/number. The variant-specific timestamp
 * columns (`held_at`, `confirmed_at`, …) are nullable in the table and
 * filled per the booking's current state; `Schema.is(...)` narrows the
 * union before each assignment so the row never carries a column that
 * doesn't apply to its state.
 */

type BookingRow = typeof bookings.$inferInsert
type BookingSelectRow = typeof bookings.$inferSelect

const encodeBooking = Schema.encodeSync(BookingSchema)
const decodeBooking = Schema.decodeUnknownEither(BookingSchema)

const toRow = (b: Booking): BookingRow => {
  const encoded = encodeBooking(b)
  // `encodeBooking` produces the same field names as the schema; the row
  // shape is a superset (includes per-state nullable timestamps), so we
  // hand-route each field.
  const base: BookingRow = {
    id: b.id,
    code: encoded.code,
    state: b.state,
    serviceId: b.serviceId,
    providerId: b.providerId,
    resourceIds: encoded.resourceIds,
    slotStart: encoded.slot.start,
    slotEnd: encoded.slot.end,
    source: b.source,
    nameKana: encoded.nameKana,
    phoneLast4: encoded.phoneLast4,
    freeText: encoded.freeText ?? null,
  }
  switch (b.state) {
    case "Held":
      return {
        ...base,
        heldAt: b.heldAt.toString(),
        expiresAt: b.expiresAt.toString(),
      }
    case "Confirmed":
      return {
        ...base,
        confirmedAt: b.confirmedAt.toString(),
      }
    case "Cancelled":
      return {
        ...base,
        cancelledAt: b.cancelledAt.toString(),
        cancelledBy: b.cancelledBy,
        cancelReason: b.reason,
      }
    case "Completed":
      return {
        ...base,
        completedAt: b.completedAt.toString(),
      }
    case "NoShow":
      return {
        ...base,
        markedAt: b.markedAt.toString(),
        markedBy: b.markedBy,
      }
  }
}

/**
 * Re-build the encoded booking shape from a row, then run it through
 * `Schema.decodeUnknownEither(BookingSchema)` to materialise the typed
 * `Booking`. Decoding is the same path the in-memory and DurableObject
 * adapters take, so a row that survives the schema is identical to a
 * booking minted by the use case layer.
 */
const fromRow = (row: BookingSelectRow): Booking | null => {
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
  let encoded: unknown
  switch (row.state) {
    case "Held":
      if (row.heldAt === null || row.expiresAt === null) return null
      encoded = { ...common, state: "Held", heldAt: row.heldAt, expiresAt: row.expiresAt }
      break
    case "Confirmed":
      if (row.confirmedAt === null) return null
      encoded = { ...common, state: "Confirmed", confirmedAt: row.confirmedAt }
      break
    case "Cancelled":
      if (row.cancelledAt === null || row.cancelledBy === null || row.cancelReason === null)
        return null
      encoded = {
        ...common,
        state: "Cancelled",
        cancelledAt: row.cancelledAt,
        cancelledBy: row.cancelledBy,
        reason: row.cancelReason,
      }
      break
    case "Completed":
      if (row.completedAt === null) return null
      encoded = { ...common, state: "Completed", completedAt: row.completedAt }
      break
    case "NoShow":
      if (row.markedAt === null || row.markedBy === null) return null
      encoded = { ...common, state: "NoShow", markedAt: row.markedAt, markedBy: row.markedBy }
      break
  }
  const r = decodeBooking(encoded)
  return r._tag === "Right" ? r.right : null
}

export const makeD1BookingRepository = (db: D1Database): Layer.Layer<BookingRepository> => {
  const orm = drizzle(db)
  return Layer.succeed(
    BookingRepository,
    BookingRepository.of({
      findById: (id: BookingId) =>
        Effect.tryPromise({
          try: () => orm.select().from(bookings).where(eq(bookings.id, id)).limit(1),
          catch: () => new BookingNotFoundError({}),
        }).pipe(
          Effect.flatMap((rows) => {
            const row = rows[0]
            if (row === undefined) return Effect.fail(new BookingNotFoundError({}))
            const decoded = fromRow(row)
            return decoded === null
              ? Effect.fail(new BookingNotFoundError({}))
              : Effect.succeed(decoded)
          }),
        ),

      findByCode: (code: BookingCode) =>
        Effect.tryPromise({
          try: () => orm.select().from(bookings).where(eq(bookings.code, code)).limit(1),
          catch: () => new BookingNotFoundError({}),
        }).pipe(
          Effect.flatMap((rows) => {
            const row = rows[0]
            if (row === undefined) return Effect.fail(new BookingNotFoundError({}))
            const decoded = fromRow(row)
            return decoded === null
              ? Effect.fail(new BookingNotFoundError({}))
              : Effect.succeed(decoded)
          }),
        ),

      upsert: (booking) =>
        Effect.promise(() =>
          orm
            .insert(bookings)
            .values(toRow(booking))
            .onConflictDoUpdate({ target: bookings.id, set: toRow(booking) })
            .run(),
        ),
    }),
  )
}
