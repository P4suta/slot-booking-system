import { Duration, Effect } from "effect"
import type { TraceId } from "../../domain/errors/TraceId.js"
import { Logger } from "../ports/Logger.js"
import { PiiPurger } from "../ports/PiiPurger.js"
import { infoPayload } from "./_log.js"

/**
 * Scheduled use case: NULL the PII columns on every booking whose
 * terminal state was reached more than {@link PII_RETENTION} ago.
 *
 * Wired to a Cloudflare Workers `scheduled` cron trigger in
 * `apps/default/src/worker.ts`. The audit log keeps the booking event
 * trail untouched; only the customer-supplied fields
 * (`nameKana`, `phoneLast4`, `freeText`) are nulled.
 *
 * Returns the number of rows affected so the scheduler can attach it
 * to the log payload — useful for spotting drift (e.g. zero rows
 * touched for a week probably means the cron stopped firing).
 */
export const PII_RETENTION = Duration.days(2 * 365)

export type PurgeStalePiiInput = {
  readonly traceId?: TraceId
}

export const PurgeStalePii = (
  input: PurgeStalePiiInput = {},
): Effect.Effect<{ readonly purged: number }, never, Logger | PiiPurger> =>
  Effect.gen(function* () {
    const purger = yield* PiiPurger
    const logger = yield* Logger

    const purged = yield* purger.purgeOlderThan(PII_RETENTION)
    yield* logger.info(infoPayload("PiiPurged", "I_USECASE_PURGE_PII", { purged }, input.traceId))
    return { purged }
  })
