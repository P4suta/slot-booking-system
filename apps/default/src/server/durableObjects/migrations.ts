/**
 * Versioned migration ledger for the QueueShop DO's local SQLite
 * (ADR-0082). Replaces the prior PRAGMA-poll-on-every-boot pattern
 * with an append-only ordered list of `Migration` records; the
 * `_migrations` table records which ids have been applied so each
 * cold boot replays only the pending tail.
 *
 * Schema evolution is now a single append to {@link MIGRATIONS}.
 * The legacy bootstrap path (DOs that were created before this
 * ledger landed) is handled by `seedLegacy` — it inspects the
 * existing tables / columns via PRAGMA once on first boot and
 * pre-marks every migration that the schema already satisfies.
 */
import { aggregateSnapshots } from "../schema/aggregateSnapshots.js"
import { outbox, outboxDead } from "../schema/outbox.js"
import { ticketEvents } from "../schema/ticketEvents.js"
import { tickets } from "../schema/tickets.js"
import { tablesToDDL } from "./ddl.js"

type Migration = {
  readonly id: number
  readonly name: string
  readonly up: (sql: SqlStorage) => void
}

const INITIAL_DDL = tablesToDDL([tickets, ticketEvents, outbox, outboxDead, aggregateSnapshots])

/**
 * Ordered migration list. **Append only** — never renumber, never
 * delete. The id sequence is the dependency order; each entry's
 * `up` is idempotent (uses `IF NOT EXISTS` / column-existence
 * checks) so a re-run on a partially-applied schema is safe.
 */
const MIGRATIONS: readonly Migration[] = [
  {
    id: 1,
    name: "initial-schema",
    up: (sql) => {
      for (const stmt of INITIAL_DDL) sql.exec(stmt)
    },
  },
  {
    id: 2,
    name: "appointment-at",
    up: (sql) => {
      addColumnIfMissing(sql, "tickets", "appointment_at", "TEXT")
    },
  },
  {
    id: 3,
    name: "checked-in-at",
    up: (sql) => {
      addColumnIfMissing(sql, "tickets", "checked_in_at", "TEXT")
    },
  },
] as const

const LEDGER_DDL = `CREATE TABLE IF NOT EXISTS _migrations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
)`

const addColumnIfMissing = (sql: SqlStorage, table: string, column: string, type: string): void => {
  const rows = sql.exec(`PRAGMA table_info(${table})`).toArray()
  if (rows.some((r) => r.name === column)) return
  sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
}

const tableExists = (sql: SqlStorage, table: string): boolean => {
  const row = sql
    .exec("SELECT name FROM sqlite_master WHERE type='table' AND name = ?", table)
    .toArray()[0]
  return row !== undefined
}

const columnExists = (sql: SqlStorage, table: string, column: string): boolean => {
  if (!tableExists(sql, table)) return false
  const rows = sql.exec(`PRAGMA table_info(${table})`).toArray()
  return rows.some((r) => r.name === column)
}

/**
 * One-time legacy seed: DOs that booted before this ledger landed
 * already have `tickets / ticket_events / outbox / outbox_dead /
 * aggregate_snapshots` populated plus the two ALTER TABLE columns.
 * Inspect the live schema and pre-mark every migration that's
 * already satisfied — the regular `applyPending` path then has
 * nothing to do.
 */
const seedLegacy = (sql: SqlStorage, applied: Set<number>): void => {
  const nowIso = new Date().toISOString()
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue
    let satisfied = false
    if (m.id === 1) satisfied = tableExists(sql, "tickets")
    else if (m.id === 2) satisfied = columnExists(sql, "tickets", "appointment_at")
    else if (m.id === 3) satisfied = columnExists(sql, "tickets", "checked_in_at")
    if (satisfied) {
      sql.exec(
        "INSERT INTO _migrations (id, name, applied_at) VALUES (?, ?, ?)",
        m.id,
        m.name,
        nowIso,
      )
      applied.add(m.id)
    }
  }
}

/**
 * Apply every migration not yet recorded in `_migrations`. Safe to
 * call on every boot; first call seeds the ledger for legacy DOs,
 * subsequent calls are O(1) once the ledger is in sync.
 */
const applyPending = (sql: SqlStorage): void => {
  sql.exec(LEDGER_DDL)
  const applied = new Set<number>(
    sql
      .exec("SELECT id FROM _migrations")
      .toArray()
      .map((r) => Number(r.id)),
  )
  seedLegacy(sql, applied)
  const nowIso = new Date().toISOString()
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue
    m.up(sql)
    sql.exec(
      "INSERT INTO _migrations (id, name, applied_at) VALUES (?, ?, ?)",
      m.id,
      m.name,
      nowIso,
    )
  }
}

/**
 * Drop-in replacement for the prior `ensureDurableObjectSchema` —
 * routes through the migration ledger so every consumer continues
 * to call one initialiser without knowing the underlying machinery.
 */
export const ensureDurableObjectSchema = (sql: SqlStorage): void => {
  applyPending(sql)
}
