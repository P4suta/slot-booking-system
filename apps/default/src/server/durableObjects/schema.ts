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
 * Why not `drizzle-kit migrate`: the kit produces a directory of `.sql`
 * files plus a JSON journal that wrangler does not bundle by default,
 * and the per-deployment migration stack adds complexity that this
 * project doesn't need (schema is small, evolution is captured in ADRs).
 * `CREATE TABLE IF NOT EXISTS` is idempotent and re-runs cheaply on
 * every cold start, so the DO can self-heal after eviction without
 * any orchestration.
 */
export const DURABLE_OBJECT_DDL = [
  /* bookings — read-side projection (snapshot per aggregate). */
  `CREATE TABLE IF NOT EXISTS bookings (
     id text PRIMARY KEY NOT NULL,
     code text NOT NULL UNIQUE,
     state text NOT NULL,
     service_id text NOT NULL,
     provider_id text NOT NULL,
     resource_ids text NOT NULL,
     slot_start text NOT NULL,
     slot_end text NOT NULL,
     source text NOT NULL,
     name_kana text,
     phone_last4 text,
     free_text text,
     held_at text,
     expires_at text,
     confirmed_at text,
     cancelled_at text,
     cancelled_by text,
     cancel_reason text,
     completed_at text,
     marked_at text,
     marked_by text,
     updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
   )`,
  /* booking_events — append-only truth log, bitemporal + versioned. */
  `CREATE TABLE IF NOT EXISTS booking_events (
     id text PRIMARY KEY NOT NULL,
     booking_id text NOT NULL,
     seq integer NOT NULL,
     version integer NOT NULL DEFAULT 1,
     type text NOT NULL,
     occurred_at text NOT NULL,
     recorded_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
     payload text
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_booking_events_booking_seq
     ON booking_events (booking_id, seq)`,
  /* outbox — pending DO → D1 relay rows, with retry budget. */
  `CREATE TABLE IF NOT EXISTS outbox (
     id text PRIMARY KEY NOT NULL,
     booking_id text NOT NULL,
     seq integer NOT NULL,
     type text NOT NULL,
     payload text NOT NULL,
     snapshot text NOT NULL,
     enqueued_at text NOT NULL,
     next_attempt_at text NOT NULL,
     attempts integer NOT NULL DEFAULT 0,
     last_error text
   )`,
  `CREATE INDEX IF NOT EXISTS ix_outbox_next_attempt
     ON outbox (next_attempt_at)`,
  /* outbox_dead — rows that exhausted the retry budget. */
  `CREATE TABLE IF NOT EXISTS outbox_dead (
     id text PRIMARY KEY NOT NULL,
     booking_id text NOT NULL,
     seq integer NOT NULL,
     type text NOT NULL,
     payload text NOT NULL,
     snapshot text NOT NULL,
     enqueued_at text NOT NULL,
     died_at text NOT NULL,
     attempts integer NOT NULL,
     last_error text NOT NULL
   )`,
] as const

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
