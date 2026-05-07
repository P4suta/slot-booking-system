import { fixedBackoff, nextAttemptAt } from "@booking/core"
import { asc, eq, lte } from "drizzle-orm"
import { drizzle as drizzleD1 } from "drizzle-orm/d1"
import { drizzle } from "drizzle-orm/durable-sqlite"
import type { DurableObjectStorageLike } from "../adapters/DurableObjectEventSourcedRepositoryLive.js"
import { bookingEvents, bookings, doTables, outbox, outboxDead } from "../schema/index.js"

/**
 * Outbox relay (ADR-0006, T1-D). The DO's local SQLite is the truth
 * for in-flight booking days; D1 is the long-retention read mirror +
 * audit log. Each `save` enqueues an outbox row carrying both the
 * event and the latest folded snapshot (ADR-0029 D4 — single-phase
 * relay, no D1-side projection logic).
 *
 * Per alarm tick:
 *   1. SELECT outbox rows where `next_attempt_at <= now()`, ordered
 *      by `next_attempt_at` ASC, LIMIT BATCH_SIZE.
 *   2. For each row, atomically (in a D1 batch):
 *      a. INSERT INTO booking_events (idempotent on `id` PK)
 *      b. INSERT INTO bookings ON CONFLICT DO UPDATE (idempotent)
 *   3. On D1 success: DELETE FROM outbox WHERE id = ...
 *   4. On D1 failure: bump `attempts`, set `last_error`, push
 *      `next_attempt_at` by exponential backoff. After exhausting the
 *      retry budget, move the row to `outbox_dead` (operator inspects).
 *
 * Backoff schedule: 1s / 5s / 30s / 5min / 30min. After the 6th
 * failure the row is dead-lettered.
 *
 * Idempotency: the INSERT on `booking_events.id` PK and ON CONFLICT
 * UPDATE on `bookings.id` PK make the at-least-once relay safe under
 * alarm replay or worker restart mid-flush.
 */

const BATCH_SIZE = 100

/**
 * Outbox retry schedule: 1s / 5s / 30s / 5min / 30min, then
 * dead-letter on the 6th failure. Authored as a `BackoffPolicy`
 * value so the schedule is testable and swappable without touching
 * the drain loop below — the algorithm-data separation core
 * documents in `application/runtime/BackoffPolicy.ts`.
 */
const RELAY_BACKOFF = fixedBackoff([1_000, 5_000, 30_000, 300_000, 1_800_000])

type DrainResult = {
  readonly drained: number
  readonly retried: number
  readonly dead: number
}

/**
 * Drain pending outbox rows. Returns the count of rows that landed in
 * D1 (`drained`), failed-and-rescheduled (`retried`), and exceeded the
 * retry budget (`dead`).
 */
export const drainOutbox = async (
  doStorage: DurableObjectStorageLike,
  d1: D1Database,
  nowMs: number = Date.now(),
): Promise<DrainResult> => {
  const doDb = drizzle(doStorage as unknown as DurableObjectStorage, { schema: doTables })
  const d1Db = drizzleD1(d1)
  const nowIso = new Date(nowMs).toISOString()

  const due = doDb
    .select()
    .from(outbox)
    .where(lte(outbox.nextAttemptAt, nowIso))
    .orderBy(asc(outbox.nextAttemptAt))
    .limit(BATCH_SIZE)
    .all()

  if (due.length === 0) return { drained: 0, retried: 0, dead: 0 }

  let drained = 0
  let retried = 0
  let dead = 0

  for (const row of due) {
    try {
      /* Phase 0.7-β5: read the live snapshot from DO storage at drain
       * time rather than carrying a stale embedded copy. If the row is
       * gone (purge / manual delete), the relay treats this as a
       * dead-letter — we cannot reconstruct the projection. */
      const snapshot = doDb.select().from(bookings).where(eq(bookings.id, row.bookingId)).get() as
        | typeof bookings.$inferInsert
        | undefined
      if (snapshot === undefined) {
        throw new Error(`outbox row ${row.id} references missing bookings.id ${row.bookingId}`)
      }

      const eventInsert = d1Db
        .insert(bookingEvents)
        .values({
          id: row.id,
          bookingId: row.bookingId,
          seq: row.seq,
          version: (row.payload.version as number | undefined) ?? 1,
          type: row.type as typeof bookingEvents.$inferInsert.type,
          occurredAt: row.payload.occurredAt as string,
          recordedAt: row.payload.recordedAt as string,
          payload: row.payload,
        })
        .onConflictDoNothing({ target: bookingEvents.id })

      const snapshotInsert = d1Db
        .insert(bookings)
        .values(snapshot)
        .onConflictDoUpdate({ target: bookings.id, set: snapshot })

      await d1.batch(
        [eventInsert.toSQL(), snapshotInsert.toSQL()].map((q) =>
          d1.prepare(q.sql).bind(...q.params),
        ),
      )

      doDb.delete(outbox).where(eq(outbox.id, row.id)).run()
      drained++
    } catch (err) {
      const attempts = row.attempts + 1
      const errMsg = err instanceof Error ? `${err.name}: ${err.message}` : String(err)

      if (attempts >= RELAY_BACKOFF.maxAttempts) {
        /* Dead-letter: move to outbox_dead, drop from outbox. The
         * snapshot is intentionally not carried — operators inspecting
         * a dead-lettered row read the live `bookings` row directly. */
        doStorage.transactionSync(() => {
          doDb
            .insert(outboxDead)
            .values({
              id: row.id,
              bookingId: row.bookingId,
              seq: row.seq,
              type: row.type,
              payload: row.payload,
              enqueuedAt: row.enqueuedAt,
              diedAt: nowIso,
              attempts,
              lastError: errMsg,
            })
            .run()
          doDb.delete(outbox).where(eq(outbox.id, row.id)).run()
        })
        dead++
      } else {
        /* Retry: bump counter, reschedule with exponential backoff. */
        doDb
          .update(outbox)
          .set({
            attempts,
            lastError: errMsg,
            nextAttemptAt: nextAttemptAt(RELAY_BACKOFF, attempts - 1, nowMs),
          })
          .where(eq(outbox.id, row.id))
          .run()
        retried++
      }
    }
  }

  return { drained, retried, dead }
}

/**
 * Compute the next alarm time. Pulls the earliest `next_attempt_at`
 * from the outbox; the caller (DaySchedule) further `min`s this with
 * the earliest hold expiry timestamp.
 */
export const nextOutboxAttemptAt = (doStorage: DurableObjectStorageLike): string | null => {
  const doDb = drizzle(doStorage as unknown as DurableObjectStorage, { schema: doTables })
  const row = doDb
    .select({ at: outbox.nextAttemptAt })
    .from(outbox)
    .orderBy(asc(outbox.nextAttemptAt))
    .limit(1)
    .get()
  return row?.at ?? null
}
