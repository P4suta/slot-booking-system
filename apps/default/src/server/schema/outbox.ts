import { sql } from "drizzle-orm"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

/**
 * Transactional outbox in the DurableObject's local SQLite (ADR-0006).
 * Each ticket-event landed via `repo.save` enqueues an outbox row that
 * the DO alarm drains into D1. Idempotent by construction (the relay's
 * INSERT uses the same `id` as the event row so a re-drained row is a
 * no-op).
 */
export const outbox = sqliteTable("outbox", {
  id: text("id").primaryKey().notNull(),
  ticketId: text("ticket_id").notNull(),
  payload: text("payload").notNull(),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: text("next_attempt_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  lastError: text("last_error"),
})

/** Dead-letter queue for outbox rows whose relay budget is exhausted. */
export const outboxDead = sqliteTable("outbox_dead", {
  id: text("id").primaryKey().notNull(),
  ticketId: text("ticket_id").notNull(),
  payload: text("payload").notNull(),
  attempts: integer("attempts").notNull(),
  lastError: text("last_error").notNull(),
  recordedAt: text("recorded_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
})
