import { sqliteTable, text } from "drizzle-orm/sqlite-core"

/**
 * Calendar-date business closure (public holidays, planned maintenance).
 * Distinct from a weekday with empty `business_hours.windows`: a
 * closure overrides whatever the weekday template says for that one
 * date. `date` is an ISO `YYYY-MM-DD` (`Temporal.PlainDate`).
 */
export const closures = sqliteTable("closures", {
  id: text("id").primaryKey(),
  date: text("date").notNull(),
  reason: text("reason").notNull(),
})
