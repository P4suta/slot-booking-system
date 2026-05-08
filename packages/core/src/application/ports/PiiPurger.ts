import type { Duration } from "effect"
import { Context, type Effect } from "effect"

/**
 * Scheduled-job port: NULL out PII columns on bookings whose terminal
 * state was reached more than `olderThan` ago (ADR-0009 + SYSTEM §6.).
 *
 * Concrete adapters:
 *   - {@link D1PiiPurgerLive} (production) — `UPDATE bookings SET
 *     name_kana = NULL, phone_last4 = NULL, free_text = NULL WHERE
 *     state IN ('Cancelled', 'Completed', 'NoShow') AND <terminal_at>
 *     < datetime('now', '-2 years')`. The audit-log row stays — only
 *     the PII columns get nulled.
 *   - in-memory fake for unit tests
 *
 * The port returns the **count** of rows touched so the scheduled
 * handler can emit a structured log entry (and an alert if the count
 * is unexpectedly high — possible misconfiguration).
 */
export class PiiPurger extends Context.Service<
  PiiPurger,
  {
    readonly purgeOlderThan: (olderThan: Duration.Duration) => Effect.Effect<number>
  }
>()("@booking/core/PiiPurger") {}
