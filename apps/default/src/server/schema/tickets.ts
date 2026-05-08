import { sql } from "drizzle-orm"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

/**
 * D1 read-mirror of the ticket aggregate (Phase 2 of the queue pivot).
 * The DurableObject's local SQLite is the canonical truth (write side);
 * each successful save pushes an outbox row that the alarm relays into
 * this table. The customer-facing `Query.myTicket` reads from D1 to
 * keep the DO load profile predictable.
 *
 * Phase 2 keeps the column set minimal — Phase 3 adds the timing
 * fields (`called_at`, `served_at`, `cancelled_at`, `marked_at`) as
 * the Subscription resolver needs them.
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
