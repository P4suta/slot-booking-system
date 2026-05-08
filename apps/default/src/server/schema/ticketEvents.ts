import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

/**
 * Append-only event log mirror in D1. One row per ticket-event; the
 * DO's outbox drains here in occurredAt order. The (`ticket_id`,
 * `seq`) UNIQUE index supports the staff audit queries.
 */
export const ticketEvents = sqliteTable(
  "ticket_events",
  {
    id: text("id").primaryKey().notNull(),
    ticketId: text("ticket_id").notNull(),
    seq: integer("seq").notNull(),
    type: text("type").notNull(),
    occurredAt: text("occurred_at").notNull(),
    recordedAt: text("recorded_at").notNull(),
    payload: text("payload").notNull(),
  },
  (t) => ({
    uxBookingSeq: uniqueIndex("ux_ticket_events_ticket_seq").on(t.ticketId, t.seq),
  }),
)
