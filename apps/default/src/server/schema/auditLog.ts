import { sqliteTable, text } from "drizzle-orm/sqlite-core"

/**
 * Operator-facing audit trail. Long-retention (5y per ADR-0009);
 * never carries PII — only structured `data` keyed by entity ids and
 * `traceId` so an investigator can correlate against the request log.
 */
export const auditLog = sqliteTable("audit_log", {
  id: text("id").primaryKey(),
  at: text("at").notNull(),
  actor: text("actor", { enum: ["customer", "staff", "system"] }).notNull(),
  action: text("action").notNull(),
  bookingId: text("booking_id"),
  traceId: text("trace_id"),
  data: text("data", { mode: "json" }).$type<Readonly<Record<string, unknown>>>(),
})
