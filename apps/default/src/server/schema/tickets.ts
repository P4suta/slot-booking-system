import { sql } from "drizzle-orm"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

/**
 * Read-side projection materialized view of the ticket aggregate.
 * Event-sourcing canonical truth lives in `ticket_events` (DO-local)
 * with snapshots in `aggregate_snapshots`; this table is rebuilt by
 * applying `applyEvent` to each emitted event so query-side reads
 * stay column-projected without touching the event log on every fetch.
 *
 * D1 hosts the same shape as a downstream mirror: each successful
 * DO save pushes an outbox row that the alarm relays into D1 so
 * `myTicket` can read from D1 with predictable profile.
 */
export const tickets = sqliteTable("tickets", {
  id: text("id").primaryKey().notNull(),
  seq: integer("seq").notNull(),
  state: text("state").notNull(),
  nameKana: text("name_kana"),
  phoneLast4: text("phone_last4"),
  freeText: text("free_text"),
  issuedAt: text("issued_at").notNull(),
  calledAt: text("called_at"),
  servedAt: text("served_at"),
  cancelledAt: text("cancelled_at"),
  markedAt: text("marked_at"),
  reason: text("reason"),
  cancelledBy: text("cancelled_by"),
  calledBy: text("called_by"),
  servedBy: text("served_by"),
  markedBy: text("marked_by"),
  // The repo serialises the full Ticket aggregate as JSON for the
  // DO-local snapshot store; the column-projected fields above
  // mirror it for D1 read access via the outbox relay.
  payload: text("payload").notNull(),
  revision: integer("revision").notNull().default(0),
  updatedAt: text("updated_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
})
