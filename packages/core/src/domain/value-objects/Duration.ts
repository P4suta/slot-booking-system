import { Temporal } from "@js-temporal/polyfill"

/**
 * Phantom-tagged kinds for time intervals (ADR-0077).
 *
 * Each magnitude in the system carries its purpose at the type level —
 * a `Duration<"Grace">` cannot be added to a `Duration<"Keepalive">`,
 * because the compiler refuses to unify the phantom witnesses. This
 * rules out a class of category errors (treating an alarm TTL as a
 * polling interval, etc.) without runtime overhead.
 */
export type DurationKind =
  | "Grace"
  | "ServingThreshold"
  | "PendingNoShowTtl"
  | "CheckInWindow"
  | "Keepalive"
  | "BroadcastCoalesce"
  | "ReconnectBackoff"
  | "Generic"

declare const __durationKind: unique symbol

/**
 * Non-negative integer milliseconds tagged by purpose.
 *
 * The runtime carrier is the public `ms` field — every consumer that
 * needs an `epoch + delta` calculation reaches for `Duration.toMillis`,
 * never destructures the brand. The `kind` field is the witness used
 * by helpers; the phantom slot is solely for compile-time variance.
 *
 * Equality is structural: two `Duration<K>` values with the same `ms`
 * compare equal under {@link Duration.compare}. There is no observable
 * difference between values built via {@link Duration.minutes} and
 * those built via {@link Duration.fromTemporal} once normalised.
 */
export type Duration<K extends DurationKind = DurationKind> = {
  readonly ms: number
  readonly kind: K
  readonly [__durationKind]?: K
}

const make = <K extends DurationKind>(kind: K, ms: number): Duration<K> => {
  if (!Number.isInteger(ms) || ms < 0 || !Number.isFinite(ms)) {
    throw new RangeError(
      `Duration<${kind}> must be a non-negative integer of ms, got ${String(ms)}`,
    )
  }
  return { ms, kind }
}

/**
 * Constructors and algebraic operations over `Duration<K>`.
 *
 * The shape matches a commutative monoid `(Duration<K>, add, zero)` —
 * laws checked in `test/value-objects/Duration.test.ts`. `compare`
 * defines a total order; together they give an ordered abelian monoid
 * sufficient for heap keys / coalesce windows / EDF lateness.
 */
export const Duration = {
  ms: <K extends DurationKind>(kind: K, ms: number): Duration<K> => make(kind, ms),

  seconds: <K extends DurationKind>(kind: K, s: number): Duration<K> =>
    make(kind, Math.round(s * 1000)),

  minutes: <K extends DurationKind>(kind: K, m: number): Duration<K> =>
    make(kind, Math.round(m * 60_000)),

  zero: <K extends DurationKind>(kind: K): Duration<K> => make(kind, 0),

  fromTemporal: <K extends DurationKind>(kind: K, d: Temporal.Duration): Duration<K> =>
    make(kind, Math.round(d.total({ unit: "milliseconds" }))),

  toMillis: <K extends DurationKind>(d: Duration<K>): number => d.ms,

  toTemporal: <K extends DurationKind>(d: Duration<K>): Temporal.Duration =>
    Temporal.Duration.from({ milliseconds: d.ms }),

  add: <K extends DurationKind>(a: Duration<K>, b: Duration<K>): Duration<K> => ({
    ms: a.ms + b.ms,
    kind: a.kind,
  }),

  compare: <K extends DurationKind>(a: Duration<K>, b: Duration<K>): -1 | 0 | 1 =>
    a.ms < b.ms ? -1 : a.ms > b.ms ? 1 : 0,

  equals: <K extends DurationKind>(a: Duration<K>, b: Duration<K>): boolean => a.ms === b.ms,

  /**
   * Add `d` to an epoch-millisecond instant. Convenience to avoid the
   * `now + Duration.toMillis(d)` idiom proliferating at every alarm /
   * grace deadline call site.
   */
  addToEpoch: <K extends DurationKind>(epochMs: number, d: Duration<K>): number => epochMs + d.ms,
} as const
