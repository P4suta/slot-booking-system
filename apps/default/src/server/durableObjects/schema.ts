import { bookingEvents } from "../schema/bookingEvents.js"
import { bookings } from "../schema/bookings.js"
import { outbox, outboxDead } from "../schema/outbox.js"
import { tablesToDDL } from "./ddl.js"

/**
 * DDL for the DurableObject's local SQLite. Applied idempotently from
 * the DO constructor under `ctx.blockConcurrencyWhile`, so every fetch
 * served by the DO sees a fully-migrated schema.
 *
 * The shape mirrors `apps/default/src/server/schema/index.ts` exactly
 * — DO and D1 share Drizzle definitions for `bookings`,
 * `booking_events`, `outbox`, `outbox_dead`. `audit_log` is omitted
 * because the DO is the write side, not the audit sink (audit lives
 * in D1, populated by `D1AuditLoggerLive` in Phase 0.12).
 *
 * The DDL is **derived** from the drizzle table definitions via
 * {@link tablesToDDL}. Drizzle is the single source of truth for
 * column shape; adding a column / index in
 * `apps/default/src/server/schema/*.ts` propagates here automatically.
 *
 * Why not `drizzle-kit migrate`: the kit produces a directory of `.sql`
 * files plus a JSON journal that wrangler does not bundle by default,
 * and the per-deployment migration stack adds complexity that this
 * project doesn't need (schema is small, evolution is captured in
 * ADRs). `CREATE TABLE IF NOT EXISTS` is idempotent and re-runs cheaply
 * on every cold start, so the DO can self-heal after eviction without
 * any orchestration.
 */
const DURABLE_OBJECT_DDL = tablesToDDL([bookings, bookingEvents, outbox, outboxDead])

/**
 * Apply the DDL to the DO's SQL storage. Idempotent — every statement
 * uses `IF NOT EXISTS`, so running this on every constructor invocation
 * costs ~6 cheap calls. Future schema migrations should add new
 * `ALTER TABLE` statements *after* the existing CREATEs (older
 * deployments that have already applied the CREATEs will skip them and
 * pick up only the ALTERs).
 */
export const ensureDurableObjectSchema = (sql: SqlStorage): void => {
  for (const stmt of DURABLE_OBJECT_DDL) {
    sql.exec(stmt)
  }
}
