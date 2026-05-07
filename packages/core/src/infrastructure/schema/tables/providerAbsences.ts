import { sqliteTable, text } from "drizzle-orm/sqlite-core"

/**
 * Per-provider unavailability window (vacation, training, sick leave).
 * `[start, end)` is `Temporal.Instant` (UTC, ISO with `Z`); the slot
 * search subtracts these intervals from the provider's coverage of
 * the day's `OpenWindow`s before scoring resource availability.
 *
 * No FK to `providers` (D1 doesn't enforce FKs by default and this
 * project keeps integrity in domain logic — orphaned absences are
 * rejected by the catalog adapter on read).
 */
export const providerAbsences = sqliteTable("provider_absences", {
  id: text("id").primaryKey(),
  providerId: text("provider_id").notNull(),
  start: text("start").notNull(),
  end: text("end").notNull(),
  reason: text("reason").notNull(),
})
