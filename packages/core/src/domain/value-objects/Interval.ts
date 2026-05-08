import { Result } from "effect"

/**
 * Total ordering on a point type. Returns negative when `a < b`, zero
 * when `a === b`, positive when `a > b`. Aligned with the contract of
 * `Temporal.{Instant,PlainTime,PlainDate}.compare` so the polyfill's
 * statics drop in unchanged.
 */
export type Comparator<T> = (a: T, b: T) => number

/**
 * Half-open interval `[start, end)` over a comparable point type. The
 * generic parameter `T` lets the same algebra serve `TimeSlot`
 * (Instant), `OpenWindow` (PlainTime), and `ProviderAbsence` (Instant)
 * without each value object reinventing `start < end`, overlap, and
 * containment for its own temporal granularity.
 *
 * The smart constructor (`intervalSmartCtor`) rejects `start === end`
 * as zero-length, so downstream code can rely on `start < end`.
 */
export type Interval<T> = {
  readonly start: T
  readonly end: T
}

/**
 * Build a domain-specific smart constructor for a half-open interval.
 * Each value object supplies its own comparator and error factory; the
 * resulting function is `(start, end) => Result<Interval<T>, E>`.
 *
 * Curried so the bound `(cmp, makeError)` form lives at module scope
 * and the call site stays a clean two-arg invocation.
 */
export const intervalSmartCtor =
  <T, E>(cmp: Comparator<T>, makeError: () => E) =>
  (start: T, end: T): Result.Result<Interval<T>, E> => {
    if (cmp(start, end) >= 0) return Result.fail(makeError())
    return Result.succeed({ start, end })
  }

/**
 * Bind a comparator to obtain a specialised `overlaps` predicate. Two
 * half-open intervals overlap iff `a.start < b.end && b.start < a.end`;
 * touching boundaries (`a.end === b.start`) do not overlap.
 */
export const overlapsBy =
  <T>(cmp: Comparator<T>) =>
  (a: Interval<T>, b: Interval<T>): boolean =>
    cmp(a.start, b.end) < 0 && cmp(b.start, a.end) < 0

/**
 * Bind a comparator to obtain a specialised `containedIn` predicate.
 * `inner` is contained in `outer` iff
 * `outer.start <= inner.start && inner.end <= outer.end`.
 */
export const containedInBy =
  <T>(cmp: Comparator<T>) =>
  (inner: Interval<T>, outer: Interval<T>): boolean =>
    cmp(inner.start, outer.start) >= 0 && cmp(inner.end, outer.end) <= 0
