import { sql } from "drizzle-orm"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

/**
 * Aggregate-snapshot table for the QueueShop DO. Event-sourcing
 * canonical truth lives in `ticket_events`; the snapshot is a
 * load accelerator emitted every `SNAPSHOT_INTERVAL` events so
 * `load(id)` can hydrate from `(snapshot.payload, latest revision)`
 * plus the trailing delta in the event log instead of replaying the
 * whole history. One row per ticket id; the row is upserted (not
 * appended) so the table never outgrows the live ticket cardinality.
 *
 * `revision` is the aggregate revision at the moment of capture —
 * the load path replays events with `seq > revision` from
 * `ticket_events` to reach the current state.
 */
export const aggregateSnapshots = sqliteTable("aggregate_snapshots", {
  ticketId: text("ticket_id").primaryKey().notNull(),
  revision: integer("revision").notNull(),
  payload: text("payload").notNull(),
  createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
})
