import { type Booking, BookingFromRow } from "@booking/core"
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
 * Routing from the discriminated `Booking` to the flat row is delegated
 * to `BookingFromRow` (Schema.Union of five per-variant transforms,
 * ADR-0032) followed by `Schema.encode(BookingRowSchema)` to convert
 * `Temporal.Instant` columns to ISO-8601 strings for SQLite. There is
 * no hand-written per-state switch in this file — the codec is
 * exhaustive at compile time.
 *
 * Idempotency: every write is `INSERT … ON CONFLICT DO UPDATE`, so
 * re-applying the same snapshot is a no-op (at-least-once semantics
 * for the outbox relay, ADR-0006).
 */

type BookingRow = typeof bookings.$inferInsert

// Booking → BookingRow.Type (DU → flat row, both at the Type level —
// Instant stays Instant, brands stay branded).
const encodeRowType = Schema.encodeSync(BookingFromRow)

const toRow = (b: Booking): BookingRow => {
  const r = encodeRowType(b)
  // Project to the wire shape Drizzle's `text` columns expect: Instants
  // become ISO-8601 strings, the rest is structurally identical. Each
  // arm of the union owns exactly its variant's timestamps; the rest of
  // the columns stay null on the wire (per the nullable schema).
  const base = {
    id: r.id,
    code: r.code,
    state: r.state,
    serviceId: r.serviceId,
    providerId: r.providerId,
    resourceIds: [...r.resourceIds],
    slotStart: r.slotStart.toString(),
    slotEnd: r.slotEnd.toString(),
    source: r.source,
    nameKana: r.nameKana,
    phoneLast4: r.phoneLast4,
    freeText: r.freeText ?? null,
  }
  switch (r.state) {
    case "Held":
      return { ...base, heldAt: r.heldAt.toString(), expiresAt: r.expiresAt.toString() }
    case "Confirmed":
      return { ...base, confirmedAt: r.confirmedAt.toString() }
    case "Cancelled":
      return {
        ...base,
        cancelledAt: r.cancelledAt.toString(),
        cancelledBy: r.cancelledBy,
        cancelReason: r.cancelReason,
      }
    case "Completed":
      return { ...base, completedAt: r.completedAt.toString() }
    case "NoShow":
      return { ...base, markedAt: r.markedAt.toString(), markedBy: r.markedBy }
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
