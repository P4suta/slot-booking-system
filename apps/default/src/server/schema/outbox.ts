import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

/**
 * Outbox table for at-least-once DO → D1 sync (ADR-0006). Each row is
 * one event the DO emitted that has yet to be acknowledged downstream;
 * the relay process consumes rows in `next_attempt_at` order, batch-
 * inserts into `booking_events` (idempotent on `id` PK), then deletes
 * the outbox row.
 *
 * Failure mode: the `attempts` counter is bumped, `last_error` records
 * the operator-facing reason, and `next_attempt_at` is pushed out by
 * an exponential backoff (1s / 5s / 30s / 5m / 30m). After the 6th
 * failure the row is moved to `outbox_dead` (rare; alerts an operator).
 *
 * Phase 0.7-β5 dropped the inline `snapshot` column; the relay now
 * reads the current `bookings` row from DO local SQLite at drain
 * time. N events on the same booking previously produced N copies
 * of the snapshot inside this table; the new shape stores it once
 * (in `bookings`) and links by `bookingId`. The relay handles the
 * "snapshot vanished mid-flight" case by dead-lettering.
 *
 * Phase 0.6 / ADR-0006 / T1-D.
 */
export const outbox = sqliteTable(
  "outbox",
  {
    id: text("id").primaryKey(),
    bookingId: text("booking_id").notNull(),
    seq: integer("seq").notNull(),
    type: text("type").notNull(),
    payload: text("payload", { mode: "json" }).$type<Readonly<Record<string, unknown>>>().notNull(),
    enqueuedAt: text("enqueued_at").notNull(),
    nextAttemptAt: text("next_attempt_at").notNull(),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
  },
  (t) => [index("ix_outbox_next_attempt").on(t.nextAttemptAt)],
)

/**
 * Dead-letter table — outbox rows that exceeded the retry budget are
 * moved here so the live `outbox` queue stays drainable. Operator
 * inspects rows here, fixes the root cause, then re-enqueues if
 * appropriate.
 *
 * Phase 0.7-β5: the snapshot is intentionally not carried here either
 * — by the time a row dead-letters, the live `bookings` row is the
 * authoritative source, and operators can re-enqueue with a fresh
 * snapshot read.
 */
export const outboxDead = sqliteTable("outbox_dead", {
  id: text("id").primaryKey(),
  bookingId: text("booking_id").notNull(),
  seq: integer("seq").notNull(),
  type: text("type").notNull(),
  payload: text("payload", { mode: "json" }).$type<Readonly<Record<string, unknown>>>().notNull(),
  enqueuedAt: text("enqueued_at").notNull(),
  diedAt: text("died_at").notNull(),
  attempts: integer("attempts").notNull(),
  lastError: text("last_error").notNull(),
})
