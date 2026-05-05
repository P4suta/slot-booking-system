import { PiiPurger } from "@booking/core"
import { and, inArray, isNotNull, lt, or, sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/d1"
import { Duration, Effect, Layer } from "effect"
import { bookings } from "../schema/bookings.js"

/**
 * D1-backed {@link PiiPurger}. NULLs out `name_kana`, `phone_last4`,
 * `free_text` on every terminal-state booking whose terminal timestamp
 * is older than the supplied {@link Duration.Duration}.
 *
 * "Terminal timestamp" = `cancelled_at` ∪ `completed_at` ∪ `marked_at`,
 * whichever is set for the row's state. We compare against the cutoff
 * via SQLite's ISO-8601 string ordering, which is correct because the
 * timestamps are written in canonical Z-suffixed RFC 3339 form by
 * `Schema.encodeSync(InstantSchema)`.
 *
 * The audit-log table (`audit_log`) is NOT touched — its retention is
 * 5 years per ADR-0009 and it carries no customer PII by construction.
 */
export const makeD1PiiPurger = (db: D1Database): Layer.Layer<PiiPurger> =>
  Layer.succeed(
    PiiPurger,
    PiiPurger.of({
      purgeOlderThan: (olderThan) =>
        Effect.promise(async () => {
          const orm = drizzle(db)
          const cutoffMs = Date.now() - Duration.toMillis(olderThan)
          const cutoffIso = new Date(cutoffMs).toISOString()
          const result = await orm
            .update(bookings)
            .set({
              nameKana: sql`NULL`,
              phoneLast4: sql`NULL`,
              freeText: sql`NULL`,
            })
            .where(
              and(
                inArray(bookings.state, ["Cancelled", "Completed", "NoShow"]),
                or(
                  and(isNotNull(bookings.cancelledAt), lt(bookings.cancelledAt, cutoffIso)),
                  and(isNotNull(bookings.completedAt), lt(bookings.completedAt, cutoffIso)),
                  and(isNotNull(bookings.markedAt), lt(bookings.markedAt, cutoffIso)),
                ),
                isNotNull(bookings.nameKana),
              ),
            )
            .run()
          return result.meta.changes
        }),
    }),
  )
