/*
 * Drizzle schema exports — re-export shim.
 *
 * `bookings`, `booking_events`, `outbox`, `outbox_dead`, `audit_log`
 * are local to the deployment (DO local SQLite + D1 long-retention
 * mirror). The six **catalog** tables (`services` / `providers` /
 * `resources` / `business_hours` / `closures` / `provider_absences`)
 * moved to `@booking/core`'s infrastructure layer as part of the
 * BI-10 SoT factor — the table is the single source of truth for SQL
 * column shape, the Effect Schema codec lifts it to the domain world.
 *
 * Tables present in the DO's local SQLite:
 *   `doTables` = { bookings, bookingEvents, outbox, outboxDead }
 *
 * Tables present in D1 (long-retention store):
 *   `d1Tables` = `doTables` ∪ { auditLog } ∪ catalog (re-exported from core)
 */

export {
  businessHours,
  closures,
  providerAbsences,
  providers,
  resources,
  services,
} from "@booking/core"
export * from "./auditLog.js"
export * from "./bookingEvents.js"
export * from "./bookings.js"
export * from "./outbox.js"

import {
  businessHours,
  closures,
  providerAbsences,
  providers,
  resources,
  services,
} from "@booking/core"
import { auditLog } from "./auditLog.js"
import { bookingEvents } from "./bookingEvents.js"
import { bookings } from "./bookings.js"
import { outbox, outboxDead } from "./outbox.js"

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
