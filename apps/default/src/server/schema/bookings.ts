import { sql } from "drizzle-orm"
import { sqliteTable, text } from "drizzle-orm/sqlite-core"

/**
 * Read-side projection of `Booking` (ADR-0024 draft, Step 15). The
 * write side (`booking_events`) is the source of truth; this table is
 * a fold of those events refreshed by the same DO that runs `apply`.
 *
 * Phase 0.5 draft only — no migration is generated yet (`drizzle-kit
 * generate` is disabled until Phase 1).
 */
export const bookings = sqliteTable("bookings", {
  id: text("id").primaryKey(),
  code: text("code").notNull().unique(),
  state: text("state", {
    enum: ["Held", "Confirmed", "Cancelled", "Completed", "NoShow"],
  }).notNull(),
  serviceId: text("service_id").notNull(),
  providerId: text("provider_id").notNull(),
  resourceIds: text("resource_ids", { mode: "json" }).$type<readonly string[]>().notNull(),
  slotStart: text("slot_start").notNull(),
  slotEnd: text("slot_end").notNull(),
  source: text("source", { enum: ["online", "walkin", "phone", "staff"] }).notNull(),
  // PII columns retained per ADR-0009; eligible for purge after the
  // configured retention window (2y).
  nameKana: text("name_kana").notNull(),
  phoneLast4: text("phone_last4").notNull(),
  freeText: text("free_text"),
  // Variant-specific timestamps; nullable based on the booking state.
  heldAt: text("held_at"),
  expiresAt: text("expires_at"),
  confirmedAt: text("confirmed_at"),
  cancelledAt: text("cancelled_at"),
  cancelledBy: text("cancelled_by", { enum: ["customer", "staff", "system"] }),
  cancelReason: text("cancel_reason"),
  completedAt: text("completed_at"),
  markedAt: text("marked_at"),
  markedBy: text("marked_by", { enum: ["customer", "staff", "system"] }),
  // Maintenance metadata.
  updatedAt: text("updated_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
})
