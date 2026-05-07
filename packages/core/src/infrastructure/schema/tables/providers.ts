import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

/**
 * Person performing the work. `skills` round-trips as a sorted JSON
 * array — the domain treats it as a Set, the adapter canonicalises on
 * encode so equal Provider records hash identically across restarts.
 *
 * No FK to services; the predicate `providerSatisfies(provider,
 * service.requiredSkills)` is computed at slot-search time, not stored
 * as a join table — services and skills evolve independently.
 */
export const providers = sqliteTable("providers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  skills: text("skills", { mode: "json" }).$type<readonly string[]>().notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
})
