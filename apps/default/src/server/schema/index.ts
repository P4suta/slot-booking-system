/*
 * Drizzle schema exports.
 *
 * `bookings`, `booking_events`, `outbox`, `outbox_dead` are **shared**
 * between D1 (long-retention read mirror) and DO local SQLite (write-
 * side truth). The DO instantiates the same `drizzle(...)` against
 * `state.storage` so both sides round-trip the same row shape.
 *
 * `audit_log` and the catalog tables (`services` / `providers` /
 * `resources` / `business_hours` / `closures` / `provider_absences`)
 * are **D1-only** — the per-day `DaySchedule` DO is the booking write
 * side, not the catalog write side. Catalog edits land in D1 directly
 * via `D1ServiceCatalog`.
 */
export * from "./auditLog.js"
export * from "./bookingEvents.js"
export * from "./bookings.js"
export * from "./businessHours.js"
export * from "./closures.js"
export * from "./outbox.js"
export * from "./providerAbsences.js"
export * from "./providers.js"
export * from "./resources.js"
export * from "./services.js"

import { auditLog } from "./auditLog.js"
import { bookingEvents } from "./bookingEvents.js"
import { bookings } from "./bookings.js"
import { businessHours } from "./businessHours.js"
import { closures } from "./closures.js"
import { outbox, outboxDead } from "./outbox.js"
import { providerAbsences } from "./providerAbsences.js"
import { providers } from "./providers.js"
import { resources } from "./resources.js"
import { services } from "./services.js"

/**
 * Tables present in the DO's local SQLite. Used by `drizzle(state.storage,
 * { schema: doTables })` so the type-safe query builder knows what's
 * there. The catalog and `audit_log` are intentionally absent.
 */
export const doTables = { bookings, bookingEvents, outbox, outboxDead } as const

/** Tables present in D1 (long-retention store). Includes catalog and audit log. */
export const d1Tables = {
  bookings,
  bookingEvents,
  outbox,
  outboxDead,
  auditLog,
  services,
  providers,
  resources,
  businessHours,
  closures,
  providerAbsences,
} as const
