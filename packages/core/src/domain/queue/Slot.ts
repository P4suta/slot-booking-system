import type { Temporal } from "@js-temporal/polyfill"
import { Schema } from "effect"
import { MINUTES_PER_DAY, PlainDateSchema } from "../types/Temporal.js"
import type { BusinessTimeZone } from "../value-objects/BusinessTimeZone.js"

/**
 * Slot value object — ADR-0066.
 *
 * A reservation lives in one (date, bucketId) pair on a fixed
 * granularity grid. Granularity is minutes-per-bucket, so a
 * 30-minute granularity gives 48 buckets per day numbered 0..47.
 *
 * The Schema:
 *
 *   Slot       = (date, bucketId, granularity, capacity)
 *   BucketId   = ℤ / (MINUTES_PER_DAY / granularity)
 *
 * Allen interval algebra reduces here to {equals, before, after}
 * on the bucketId equivalence class — `overlaps` is bucket-id
 * equality at fixed `(date, granularity)`.
 *
 * The morphism `bucketOf : Interval → BucketId` is exposed for
 * a future continuous-slot extension that adopts the same
 * Schema; `intervalOf` is its right-inverse on the half-open
 * `[startAt, endAt)` instant interval.
 */

/* -------------------------------------------------------------------------- */
/* Granularity                                                                 */
/* -------------------------------------------------------------------------- */

export const SlotGranularitySchema = Schema.Literals([15, 30, 60])
export type SlotGranularity = Schema.Schema.Type<typeof SlotGranularitySchema>

export const ALL_SLOT_GRANULARITIES: readonly SlotGranularity[] = [15, 30, 60] as const

/** Number of distinct bucket ids per day for a given granularity. */
export const bucketsPerDay = (g: SlotGranularity): number => MINUTES_PER_DAY / g

/* -------------------------------------------------------------------------- */
/* BucketId                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A bucket id is a non-negative integer; the upper bound is
 * `bucketsPerDay(granularity) - 1`. The Schema brands the type
 * but does not encode the granularity-dependent upper bound
 * (Schema.Number cannot statically depend on a sibling field);
 * `bucketOf` produces only valid values, and `bucketsPerDay`
 * pins the bound for runtime checks elsewhere.
 */
export const BucketIdSchema = Schema.Number.pipe(Schema.brand("BucketId"))
export type BucketId = Schema.Schema.Type<typeof BucketIdSchema>

/* -------------------------------------------------------------------------- */
/* Slot                                                                        */
/* -------------------------------------------------------------------------- */

export const SlotSchema = Schema.Struct({
  date: PlainDateSchema,
  bucketId: BucketIdSchema,
  granularity: SlotGranularitySchema,
  capacity: Schema.Number,
})
export type Slot = Schema.Schema.Type<typeof SlotSchema>

/* -------------------------------------------------------------------------- */
/* Morphisms (Interval ↔ BucketId)                                             */
/* -------------------------------------------------------------------------- */

/**
 * Project an Instant onto a BucketId at fixed granularity in the
 * business time zone. The instant's local time-of-day, expressed
 * in minutes from midnight, is integer-divided by granularity.
 *
 * Total: every Instant maps to exactly one bucket. Saturating
 * 23:59 → bucket `bucketsPerDay - 1` falls out of the floor.
 */
export const bucketOf = (
  at: Temporal.Instant,
  tz: BusinessTimeZone,
  granularity: SlotGranularity,
): BucketId => {
  const local = at.toZonedDateTimeISO(tz)
  const minutesFromMidnight = local.hour * 60 + local.minute
  return Math.floor(minutesFromMidnight / granularity) as BucketId
}

/**
 * Inverse of `bucketOf` lifted to slots: the half-open
 * `[startAt, endAt)` instant interval the slot covers in the
 * business time zone. `endAt - startAt === granularity` minutes
 * by construction.
 */
export const intervalOf = (
  slot: Slot,
  tz: BusinessTimeZone,
): { readonly startAt: Temporal.Instant; readonly endAt: Temporal.Instant } => {
  const startMinutes = slot.bucketId * slot.granularity
  const startLocal = slot.date.toZonedDateTime(tz).add({ minutes: startMinutes })
  const endLocal = startLocal.add({ minutes: slot.granularity })
  return { startAt: startLocal.toInstant(), endAt: endLocal.toInstant() }
}

/* -------------------------------------------------------------------------- */
/* Predicates & monoid                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Allen interval algebra restricted to the fixed bucket grid:
 * two slots overlap iff they share the same `(date, bucketId,
 * granularity)` triple — equivalence-class equality.
 *
 * Reflexive (`overlaps(a, a) === true`), symmetric, and
 * transitive (it is the equivalence relation). Slots with
 * different granularities never overlap by this predicate;
 * mixing granularities at runtime is a configuration error, not
 * an overlap event.
 */
export const overlaps = (a: Slot, b: Slot): boolean =>
  a.granularity === b.granularity && a.date.equals(b.date) && a.bucketId === b.bucketId

/**
 * Commutative monoid on slot occupancy counts: `(ℕ, +, 0)`. Used
 * by `slotOccupancy` (ADR-0066, ADR-0067) to fold per-ticket
 * contributions into one bucket count.
 */
export const mergeOccupancy = (a: number, b: number): number => a + b
export const ZERO_OCCUPANCY = 0
