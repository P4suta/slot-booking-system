/*
 * Drizzle schema exports.
 *
 * `bookings`, `booking_events`, `outbox`, `outbox_dead` are **shared**
 * between D1 (long-retention read mirror) and DO local SQLite (write-
 * side truth). The DO instantiates the same `drizzle(...)` against
 * `state.storage` so both sides round-trip the same row shape.
 *
 * `audit_log` is **D1-only** — DO local storage doesn't keep a
 * separate audit trail; staff actions land in D1 directly through
 * `D1AuditLoggerLive` (Phase 0.12).
 */
export * from "./auditLog.js"
export * from "./bookingEvents.js"
export * from "./bookings.js"
export * from "./outbox.js"

import { auditLog } from "./auditLog.js"
import { bookingEvents } from "./bookingEvents.js"
import { bookings } from "./bookings.js"
import { outbox, outboxDead } from "./outbox.js"

/**
 * Tables present in the DO's local SQLite. Used by `drizzle(state.storage,
 * { schema: doTables })` so the type-safe query builder knows what's
 * there. `audit_log` is intentionally absent.
 */
export const doTables = { bookings, bookingEvents, outbox, outboxDead } as const

/** Tables present in D1 (long-retention store). Includes audit log. */
export const d1Tables = { bookings, bookingEvents, outbox, outboxDead, auditLog } as const
