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
 * D1-backed AuditLogger. Persists each AuditEntry to the
 * long-retention `audit_log` table (5y, ADR-0009). Customer PII is
 * never persisted here by construction (errors only carry IDs and
 * operator-facing reason strings; the `pii-guard` CI step rejects
 * the patterns at source).
 *
 * The AuditEntry shape (declared in `domain/errors/derivations.ts`) is:
 *   `{ ts, actor, outcome: "denied", errorTag, errorCode, traceId? }`
 *
 * Failure routing: an audit-write failure never propagates to the
 * caller. The Logger port records the event so the operator can spot
 * a degraded audit channel in dashboards.
 */
export const makeD1AuditLogger = (db: D1Database) =>
  Layer.effect(
    AuditLogger,
    Effect.gen(function* () {
      const logger = yield* Logger
      return AuditLogger.of({
        write: (entry: AuditEntry) =>
          Effect.gen(function* () {
            const traceId = yield* getCurrentTraceId
            const id = newAuditLogId()
            const driz = drizzle(db)
            yield* Effect.tryPromise({
              try: () =>
                driz
                  .insert(auditLog)
                  .values({
                    id,
                    actor: entry.actor,
                    action: `${entry.outcome}:${entry.errorTag}`,
                    traceId: entry.traceId ?? traceId ?? null,
                    data: JSON.stringify({
                      ts: entry.ts,
                      errorCode: entry.errorCode,
                    }),
                  })
                  .run(),
              catch: (e) => e,
            }).pipe(
              Effect.catch((err) =>
                logger.error({
                  _tag: "AuditWriteFailed",
                  code: "E_INF_AUDIT",
                  severity: "infrastructure",
                  data: { reason: String(err) },
                }),
              ),
            )
          }),
      })
    }),
  )
