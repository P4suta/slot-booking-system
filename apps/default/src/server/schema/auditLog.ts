import { sql } from "drizzle-orm"
import { sqliteTable, text } from "drizzle-orm/sqlite-core"

/**
 * Long-retention audit log (5y per ADR-0009). Carries one row per
 * staff or customer command, accepted or rejected. PII-free by
 * construction: only ids, capability subjects, action verbs and
 * structured `data` (never `name_kana` / `phone_last4` / `free_text`).
 */
export const auditLog = sqliteTable("audit_log", {
  id: text("id").primaryKey().notNull(),
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  traceId: text("trace_id"),
  data: text("data").notNull(),
  recordedAt: text("recorded_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
})
