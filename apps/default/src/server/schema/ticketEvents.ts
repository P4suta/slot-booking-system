import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

/**
 * Append-only event log mirror in D1 (Phase 2 of the queue pivot).
 * One row per ticket-event; the DO's outbox drains here in
 * occurredAt order. The (`ticket_id`, `seq`) UNIQUE index supports
 * the audit queries on `Query.recentEvents` (Phase 6 staff audit
 * page).
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
