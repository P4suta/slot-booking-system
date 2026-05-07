import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

/**
 * Single indivisible unit of physical capacity. Capacity is expressed
 * by registering N rows of the same `type` (ADR-0008 / ADR-0012); there
 * is intentionally no `capacity: integer` column. The slot-search code
 * picks one specific resource id per booking and treats that
 * assignment as exclusive.
 */
export const resources = sqliteTable("resources", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  type: text("type").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
})
