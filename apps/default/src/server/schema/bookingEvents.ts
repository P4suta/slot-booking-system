import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

/**
 * Append-only event log — the source of truth (ADR-0024 draft).
 * `payload` carries the variant-specific fields (e.g. `Cancelled`'s
 * `reason` / `by`, `Rescheduled`'s `from` / `to`) as JSON.
 *
 * `seq` is a per-aggregate monotonic sequence so consumers can detect
 * gaps; combined with `bookingId` it forms a logical primary key.
 */
export const bookingEvents = sqliteTable("booking_events", {
  id: text("id").primaryKey(),
  bookingId: text("booking_id").notNull(),
  seq: integer("seq").notNull(),
  type: text("type", {
    enum: ["Held", "Confirmed", "Cancelled", "Rescheduled", "Completed", "NoShow"],
  }).notNull(),
  at: text("at").notNull(),
  payload: text("payload", { mode: "json" }).$type<Readonly<Record<string, unknown>>>(),
})
