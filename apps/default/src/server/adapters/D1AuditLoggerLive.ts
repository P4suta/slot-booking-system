import {
  type AuditEntry,
  AuditLogger,
  getCurrentTraceId,
  Logger,
  newAuditLogId,
} from "@booking/core"
import { drizzle } from "drizzle-orm/d1"
import { Effect, Layer } from "effect"
import { auditLog } from "../schema/index.js"

/**
 * D1-backed {@link AuditLogger}. Persists each {@link AuditEntry}
 * to the long-retention `audit_log` table (5y per ADR-0009). The
 * row carries `actor` / `action` / `traceId` plus a JSON `data` blob
 * with non-PII context (booking id, capability subject); customer
 * PII never lands here by construction.
 *
 * The mint of `id` happens in the adapter rather than at the call
 * site so the use cases stay free of TypeID generation; the
 * ULID-encoded TypeID serialises monotonic-ish per-instance, which
 * matches the audit table's natural read-by-time pattern.
 *
 * **Failure routing (Phase 2.6 / BI-9)**: an audit-write failure
 * never propagates to the caller — the user action either succeeded
 * or already failed for its own reason — but the failure is no
 * longer silently swallowed. The adapter forwards the failure to
 * the `Logger` port at `error` level with OTel semconv-aligned
 * fields (`error.type` = `"AuditWriteFailure"`, `error.code` =
 * `"E_INF_AUDIT_WRITE"`, `error.severity` = `"infrastructure"`),
 * so the operator dashboard sees the audit miss and can correlate
 * it back to the originating request via the shared `traceId`
 * derived from the active OTel span (the `Logger`-side decorator
 * merges it automatically).
 *
 * The Logger dependency is declared on the layer's R channel
 * (`Layer.Layer<AuditLogger, never, Logger>`). Production wires it
 * to `WorkersLoggerLive` upstream, and the same wiring naturally
 * carries through — no per-call-site Logger lifting needed.
 */
export const makeD1AuditLogger = (database: D1Database): Layer.Layer<AuditLogger, never, Logger> =>
  Layer.effect(
    AuditLogger,
    Effect.gen(function* () {
      const logger = yield* Logger
      return AuditLogger.of({
        write: (entry: AuditEntry) =>
          Effect.withSpan("audit_write", {
            attributes: {
              "audit.actor": entry.actor,
              "audit.action": entry.errorTag,
              "audit.outcome": entry.outcome,
              ...(entry.traceId !== undefined ? { "audit.trace_id": entry.traceId } : {}),
            },
          })(
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
            }).pipe(
              Effect.catchAll((cause) =>
                Effect.flatMap(getCurrentTraceId, (traceId) =>
                  logger.error({
                    _tag: "AuditWriteFailure",
                    code: "E_INF_AUDIT_WRITE",
                    severity: "infrastructure",
                    data: {
                      "error.type": "AuditWriteFailure",
                      "error.code": "E_INF_AUDIT_WRITE",
                      "error.severity": "infrastructure",
                      actor: entry.actor,
                      action: entry.errorTag,
                      cause: cause instanceof Error ? cause.message : String(cause),
                    },
                    ...(traceId !== undefined ? { traceId } : {}),
                    ...(entry.traceId !== undefined ? { traceId: entry.traceId } : {}),
                  }),
                ),
              ),
            ),
          ),
      })
    }),
  )
