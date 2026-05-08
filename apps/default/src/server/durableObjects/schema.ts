import { aggregateSnapshots } from "../schema/aggregateSnapshots.js"
import { auditLog } from "../schema/auditLog.js"
import { outbox, outboxDead } from "../schema/outbox.js"
import { ticketEvents } from "../schema/ticketEvents.js"
import { tickets } from "../schema/tickets.js"
import { tablesToDDL } from "./ddl.js"

/**
 * DDL for the QueueShop DO's local SQLite. Applied idempotently from
 * the DO constructor under `ctx.blockConcurrencyWhile` so every fetch
 * sees a fully-migrated schema.
 *
 * The table set mirrors `apps/default/src/server/schema/index.ts` —
 * Drizzle is the single source of truth for column shape; adding a
 * column propagates here automatically through `tablesToDDL`.
 *
 * `audit_log` is omitted (the audit sink lives in D1, populated by
 * `D1AuditLoggerLive`); `tickets` / `ticket_events` / `outbox` /
 * `outbox_dead` are the DO-local tables.
 */
const DURABLE_OBJECT_DDL = tablesToDDL([
  tickets,
  ticketEvents,
  outbox,
  outboxDead,
  aggregateSnapshots,
])

export const ensureDurableObjectSchema = (sql: SqlStorage): void => {
  for (const stmt of DURABLE_OBJECT_DDL) {
    sql.exec(stmt)
  }
}

// auditLog is referenced by D1 only; we re-export it here for the
// migration generator without including it in the DO schema.
export { auditLog }
