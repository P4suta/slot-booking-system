/**
 * Retry schedule for the transactional-outbox relay. The schedule is
 * a pure value so the relay can swap the policy (introduce jitter,
 * switch to fibonacci, etc.) without touching the outbox loop, and
 * `core` can test the schedule in isolation.
 *
 * Reference — Hohpe & Woolf "Guaranteed Delivery" / Kleppmann's
 * transactional-outbox pattern.
 */

/**
 * A retry schedule. Given the number of failed attempts so far,
 * returns the delay (in milliseconds) before the next attempt.
 *
 * `attempts` starts at 0 (the first retry) — implementations should
 * not need to special-case attempt 0 vs. later, the caller already
 * decided to retry. The maximum number of retries is implicit in
 * what the policy chooses to return for large `attempts` values:
 * an array-backed policy can saturate to its tail, while an
 * unbounded geometric policy can keep growing.
 */
export type BackoffPolicy = {
  readonly nextDelayMs: (attempts: number) => number
  /**
   * The cap on retries before the message dead-letters. Callers walk
   * the schedule until `attempts >= maxAttempts`, then move the row
   * out of the live queue.
   */
  readonly maxAttempts: number
}

/**
 * Build a fixed-table backoff policy. The tail value of the array
 * saturates further attempts — useful for "1s, 5s, 30s, 5min, 30min,
 * then dead-letter" schedules where the retry budget is the array
 * length plus one final attempt.
 */
export const fixedBackoff = (delaysMs: readonly number[]): BackoffPolicy => {
  if (delaysMs.length === 0) {
    return { nextDelayMs: () => 0, maxAttempts: 1 }
  }
  const last = delaysMs.length - 1
  // Clamp the attempt counter into `[0, last]` so the indexed read is
  // total. The trailing `?? 0` only exists because `noUncheckedIndexedAccess`
  // widens the read to `number | undefined` — the clamp guarantees it
  // never fires, so the branch is structurally unreachable.
  return {
    nextDelayMs: (attempts) => {
      const i = attempts < 0 ? 0 : attempts > last ? last : attempts
      /* v8 ignore next */
      return delaysMs[i] ?? 0
    },
    maxAttempts: delaysMs.length + 1,
  }
}

/**
 * Compute the absolute timestamp (epoch milliseconds) of the next
 * attempt given the policy and the current wall clock. Saturates at
 * the policy's tail delay; the caller chooses the wire format
 * (ISO-8601 string for SQL columns, raw ms for `setAlarm`). The
 * helper deliberately stays pure-numeric so the strict-code policy
 * for `packages/core/src` (no calendar-time constructors here)
 * applies trivially — wall-clock formatting belongs to the adapter.
 */
export const nextAttemptMs = (policy: BackoffPolicy, attempts: number, nowMs: number): number =>
  nowMs + policy.nextDelayMs(attempts)

/**
 * Decorrelated Jitter — AWS Architecture Blog "Exponential Backoff
 * and Jitter" (Marc Brooker). The recurrence
 *
 *     sleep_n = min(cap, U(base, prev_sleep * 3))
 *
 * (with `prev_sleep := base` initially, `U(a, b)` uniform on `[a, b)`)
 * spreads retries more evenly across the cap window than equal-jitter
 * or full-jitter, which matters when many writers contend on the same
 * downstream queue. The constant `3` is the AWS-recommended growth
 * factor — large enough that the schedule reaches `cap` quickly,
 * small enough that the variance stays bounded.
 *
 * The returned policy is stateful: it caches `prev_sleep` in a
 * closure so successive `nextDelayMs(n)` calls walk the recurrence.
 * Tests inject a deterministic `rng` (e.g. `() => 0.5`) to pin the
 * sequence; production sees the source through the {@link Random}
 * port and adapts it to the synchronous callback shape.
 *
 * Bounds invariant: `base <= delay <= cap` for every attempt; the
 * outer `Math.max(base, ...)` keeps the policy total even when a
 * caller inverts the inputs (`cap < base`).
 */
export const decorrelatedJitter = (
  config: {
    readonly base: number
    readonly cap: number
    readonly maxAttempts: number
  },
  rng: () => number,
): BackoffPolicy => {
  let prev = config.base
  return {
    nextDelayMs: () => {
      const lo = config.base
      const hi = prev * 3
      const sample = Math.floor(lo + rng() * (hi - lo))
      const next = Math.max(config.base, Math.min(config.cap, sample))
      prev = next
      return next
    },
    maxAttempts: config.maxAttempts,
  }
}
