import { PiiPurger } from "@booking/core"
import { Duration, Effect, Layer } from "effect"

/**
 * D1-backed PiiPurger for the queue domain. Nulls `name_kana` /
 * `phone_last4` / `free_text` on tickets whose terminal state was
 * reached more than `olderThan` ago (default 2y per ADR-0009 +
 * SYSTEM §6).
 *
 * Returns the count of rows touched so the scheduled handler can
 * emit a structured log entry / alert if the count is unexpectedly
 * high.
 */
export const makeD1PiiPurger = (db: D1Database) =>
  Layer.succeed(
    PiiPurger,
    PiiPurger.of({
      purgeOlderThan: (olderThan: Duration.Duration) =>
        Effect.tryPromise({
          try: async () => {
            const seconds = Math.round(Duration.toSeconds(olderThan))
            const result = await db
              .prepare(
                `UPDATE tickets
                 SET name_kana = NULL, phone_last4 = NULL, free_text = NULL
                 WHERE (state IN ('Cancelled', 'Served', 'NoShow'))
                   AND (
                     COALESCE(cancelled_at, served_at, marked_at) <= datetime('now', '-' || ? || ' seconds')
                   )
                   AND name_kana IS NOT NULL`,
              )
              .bind(seconds)
              .run()
            return result.meta.changes
          },
          catch: (_e) => undefined,
        }).pipe(Effect.orElseSucceed(() => 0)),
    }),
  )
