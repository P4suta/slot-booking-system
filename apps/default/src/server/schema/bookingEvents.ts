import { sql } from "drizzle-orm"
import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

/**
 * Append-only event log — the source of truth (ADR-0024).
 *
 * Bitemporal (ADR-0032): `occurred_at` is the domain timeline (when
 * the event happened), `recorded_at` is the transaction time (when it
 * was persisted). They diverge for back-dated entry; for online flows
 * they are equal.
 *
 * Versioned (ADR-0032): every event carries a literal `version`.
 * Future schema evolutions add a new variant with `version = 2` and
 * an upcaster pipeline lifts old events into the latest shape on read.
 *
 * `payload` carries the variant-specific fields (e.g. `Cancelled`'s
 * `reason` / `by`, `Rescheduled`'s `from` / `to`) as JSON.
 *
 * The `(booking_id, seq)` UNIQUE index lets the outbox relay assert
 * idempotent at-least-once: a duplicate (booking_id, seq) is detected
 * at the SQL layer rather than relying on application-level dedup.
 */
export const bookingEvents = sqliteTable(
  "booking_events",
  {
    id: text("id").primaryKey(),
    bookingId: text("booking_id").notNull(),
    seq: integer("seq").notNull(),
    version: integer("version").notNull().default(1),
    type: text("type", {
      enum: ["Held", "Confirmed", "Cancelled", "Rescheduled", "Completed", "NoShow"],
    }).notNull(),
    occurredAt: text("occurred_at").notNull(),
    recordedAt: text("recorded_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    payload: text("payload", { mode: "json" }).$type<Readonly<Record<string, unknown>>>(),
  },
  (t) => [uniqueIndex("ux_booking_events_booking_seq").on(t.bookingId, t.seq)],
)
