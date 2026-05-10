import { aggregateSnapshots } from "../schema/aggregateSnapshots.js"
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
 *
 * `tablesToDDL` only emits `CREATE TABLE IF NOT EXISTS` — it has no
 * way to evolve a column that landed in a later release. The
 * {@link IDEMPOTENT_COLUMN_ADDITIONS} table covers that gap: each
 * entry is `(table, column, type)`; the migration walks
 * `pragma_table_info` and emits `ALTER TABLE ADD COLUMN` only when
 * the column is genuinely missing. Adding a NEW migration is one
 * row in the table.
 */
const DURABLE_OBJECT_DDL = tablesToDDL([
  tickets,
  ticketEvents,
  outbox,
  outboxDead,
  aggregateSnapshots,
])

type ColumnAddition = {
  readonly table: string
  readonly column: string
  readonly type: string
}

const IDEMPOTENT_COLUMN_ADDITIONS: readonly ColumnAddition[] = [
  // ADR-0066: reservation lane appointment instant.
  { table: "tickets", column: "appointment_at", type: "TEXT" },
  // ADR-0068: customer-side arrival audit instant.
  { table: "tickets", column: "checked_in_at", type: "TEXT" },
] as const

const ensureColumn = (sql: SqlStorage, addition: ColumnAddition): void => {
  const rows = sql.exec(`PRAGMA table_info(${addition.table})`).toArray()
  const exists = rows.some((r) => r.name === addition.column)
  if (exists) return
  sql.exec(`ALTER TABLE ${addition.table} ADD COLUMN ${addition.column} ${addition.type}`)
}

export const ensureDurableObjectSchema = (sql: SqlStorage): void => {
  for (const stmt of DURABLE_OBJECT_DDL) {
    sql.exec(stmt)
  }
  for (const addition of IDEMPOTENT_COLUMN_ADDITIONS) {
    ensureColumn(sql, addition)
  }
}
