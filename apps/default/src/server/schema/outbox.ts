import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

/**
 * Outbox table for at-least-once DO → D1 sync (ADR-0006). Each row is
 * one event the DO emitted that has yet to be acknowledged downstream;
 * the relay process consumes rows in `seq` order and deletes them
 * after `D1` confirms the apply.
 */
export const outbox = sqliteTable("outbox", {
  id: text("id").primaryKey(),
  bookingId: text("booking_id").notNull(),
  seq: integer("seq").notNull(),
  type: text("type").notNull(),
  payload: text("payload", { mode: "json" }).$type<Readonly<Record<string, unknown>>>().notNull(),
  enqueuedAt: text("enqueued_at").notNull(),
  attempts: integer("attempts").notNull().default(0),
})
