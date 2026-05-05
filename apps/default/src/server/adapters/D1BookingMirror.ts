import { type Booking, BookingSchema } from "@booking/core"
import { drizzle } from "drizzle-orm/d1"
import { Effect, Schema } from "effect"
import { bookings } from "../schema/bookings.js"

/**
 * D1 read-side mirror of the booking aggregate. The DurableObject local
 * SQLite remains the truth (ADR-0006); this helper applies snapshot-
 * level upserts from the DO's `alarm()` outbox drain so that read
 * queries from the SvelteKit / GraphQL surface can hit the long-
 * retention store directly without round-tripping through the DO.
 *
 * It is **not** a port. The `BookingEventSourcedRepository` port is
 * answered by the DO's local SQLite layer (the truth). D1 is a
 * downstream replica reached only by this one-direction projection
 * function — keeping the Effect-Tag namespace clean of "fake repository"
 * stubs that would tempt callers into reading from the wrong source.
 *
 * Idempotency: every write goes through `INSERT … ON CONFLICT DO
 * UPDATE`, so re-applying the same snapshot is a no-op (at-least-once
 * semantics for the outbox relay, ADR-0006).
 *
 * Phase 0.6 leaves the per-event audit insert (`booking_events`) for
 * the outbox-completion step (T1-D); for now the snapshot row is the
 * only persisted artefact in D1.
 */

type BookingRow = typeof bookings.$inferInsert

const encodeBooking = Schema.encodeSync(BookingSchema)

const toRow = (b: Booking): BookingRow => {
  const encoded = encodeBooking(b)
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

/** Upsert a single booking snapshot into D1. Idempotent on `id` PK. */
export const upsertBookingToD1 = (db: D1Database, booking: Booking): Effect.Effect<void> =>
  Effect.promise(async () => {
    const orm = drizzle(db)
    const row = toRow(booking)
    await orm
      .insert(bookings)
      .values(row)
      .onConflictDoUpdate({ target: bookings.id, set: row })
      .run()
  })

/** Upsert many booking snapshots in a single D1 batch. */
export const upsertBookingsToD1 = (db: D1Database, list: readonly Booking[]): Effect.Effect<void> =>
  Effect.forEach(list, (b) => upsertBookingToD1(db, b), {
    concurrency: 1,
    discard: true,
  })
