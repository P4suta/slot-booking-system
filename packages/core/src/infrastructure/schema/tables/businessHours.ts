import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

/**
 * Weekly opening template. One row per `weekday` (1..7, ISO Monday=1).
 * `windows` is a canonicalised JSON array of `{ start, end }` HH:MM:SS
 * pairs (sorted, non-overlapping, no zero-length) — the domain
 * canonicalises on construction, the adapter trusts that and round-
 * trips verbatim.
 *
 * Empty `windows` (`[]`) means closed all day for that weekday — a
 * separate concern from `closures`, which targets a specific calendar
 * date.
 */
export const businessHours = sqliteTable("business_hours", {
  id: text("id").primaryKey(),
  weekday: integer("weekday").notNull(),
  windows: text("windows", { mode: "json" })
    .$type<readonly { readonly start: string; readonly end: string }[]>()
    .notNull(),
})
