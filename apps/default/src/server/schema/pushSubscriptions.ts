import { sql } from "drizzle-orm"
import { index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

/**
 * Web Push subscription registry (ADR-0073 / ADR-0074).
 *
 * One row per `(ticket_id, endpoint)`; a customer who opens the
 * `/ticket` page on two devices ends up with two rows, both deleted
 * when the ticket reaches a terminal state. The columns intentionally
 * carry no PII — `endpoint` is the opaque push-service URL, `p256dh`
 * and `auth` are the ECDH material the encryption pipeline needs.
 *
 * ADR-0009 PII discipline:
 *   - No `nameKana`, no `phoneLast4`, no IP, no UA.
 *   - The row is reaped on `Served / NoShow / Cancelled` (same TTL
 *     as the ticket aggregate) and on `404` / `410` from the push
 *     service.
 */
export const pushSubscriptions = sqliteTable(
  "push_subscriptions",
  {
    ticketId: text("ticket_id").notNull(),
    endpoint: text("endpoint").notNull(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  },
  (t) => [
    // The composite primary key is enforced by a UNIQUE index;
    // drizzle-sqlite's multi-column PRIMARY KEY DDL is not what
    // `tablesToDDL` emits, so we mirror the ADR contract with a
    // unique index. INSERT OR REPLACE on conflict is the
    // re-subscribe path (client opened /ticket twice).
    uniqueIndex("uq_push_subscriptions_pk").on(t.ticketId, t.endpoint),
    index("ix_push_subscriptions_endpoint").on(t.endpoint),
  ],
)
