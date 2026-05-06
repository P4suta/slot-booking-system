import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

/**
 * Catalog entry for a unit of work. Industry-agnostic — concrete labels
 * (`name`, `description`) live in deployment data, never in core code.
 *
 * `requiredSkills` and `requiredResourceTypes` use Set semantics in the
 * domain (see `packages/core/src/domain/entities/Service.ts`); on D1
 * they round-trip as JSON arrays. The adapter sorts on encode so the
 * row hash is deterministic regardless of Set iteration order.
 *
 * Buffers + holding days are bounded scalars — see `Duration.ts` and
 * `HoldingDays.ts` for the domain CHECK ranges (0..1440 / 0..30).
 */
export const services = sqliteTable("services", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  durationMinutes: integer("duration_minutes").notNull(),
  bufferBeforeMinutes: integer("buffer_before_minutes").notNull(),
  bufferAfterMinutes: integer("buffer_after_minutes").notNull(),
  holdingDays: integer("holding_days").notNull(),
  requiredSkills: text("required_skills", { mode: "json" }).$type<readonly string[]>().notNull(),
  requiredResourceTypes: text("required_resource_types", { mode: "json" })
    .$type<readonly string[]>()
    .notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
})
