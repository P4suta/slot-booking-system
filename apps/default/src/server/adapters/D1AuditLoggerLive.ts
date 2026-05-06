import { type AuditEntry, AuditLogger, newAuditLogId } from "@booking/core"
import { drizzle } from "drizzle-orm/d1"
import { Effect, Layer } from "effect"
import { auditLog } from "../schema/index.js"

/**
 * D1-backed {@link AuditLogger}. Persists each {@link AuditEntry}
 * to the long-retention `audit_log` table (5y per ADR-0009). The
 * row carries `_tag` / `code` / `traceId` plus a JSON `data` blob
 * with non-PII context (booking id, capability subject); customer
 * PII never lands here by construction.
 *
 * The mint of `id` happens in the adapter rather than at the call
 * site so the use cases stay free of TypeID generation; the
 * ULID-encoded TypeID serialises monotonic-ish per-instance, which
 * matches the audit table's natural read-by-time pattern.
 *
 * Failures are swallowed — an audit-write that fails should not
 * propagate to the caller (the user action either succeeded or
 * already failed for its own reason). Phase 0.12 will plumb the
 * failure into `WorkersLoggerLive` so the operator dashboard at
 * least sees the audit miss; the present `Effect.catchAll` is the
 * fence.
 */
export const makeD1AuditLogger = (database: D1Database): Layer.Layer<AuditLogger> =>
  Layer.succeed(
    AuditLogger,
    AuditLogger.of({
      write: (entry: AuditEntry) =>
        Effect.tryPromise({
          try: async () => {
            const db = drizzle(database)
            await db
              .insert(auditLog)
              .values({
                id: newAuditLogId(),
                at: entry.ts,
                actor: entry.actor,
                action: entry.errorTag,
                bookingId: null,
                traceId: entry.traceId ?? null,
                data: { code: entry.errorCode, outcome: entry.outcome },
              })
              .run()
          },
          catch: (e) => e,
        }).pipe(Effect.catchAll(() => Effect.void)),
    }),
  )
