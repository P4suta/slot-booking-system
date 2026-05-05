import { Temporal } from "@js-temporal/polyfill"
import { type Either, Schema } from "effect"
import { type DomainError, InvalidTimeSlotError } from "../errors/Errors.js"
import { InstantSchema } from "../types/Temporal.js"
import {
  type Comparator,
  containedInBy,
  type Interval,
  intervalSmartCtor,
  overlapsBy,
} from "./Interval.js"

/**
 * `[start, end)` half-open interval over UTC instants. The minimum
 * duration is 1 minute; the maximum is the configured per-day cap
 * enforced by `Minutes` (ADR-0004).
 */
export const TimeSlotSchema = Schema.Struct({
  start: InstantSchema,
  end: InstantSchema,
})
export type TimeSlot = Interval<Temporal.Instant>

// Narrowing wrapper: `Temporal.Instant.compare` accepts `string |
// Temporal.Instant` via overloads, which would widen the inferred
// `T` of `intervalSmartCtor`. The annotated binding pins the
// comparator to the strict-Instant signature.
const cmpInstant: Comparator<Temporal.Instant> = (a, b) => Temporal.Instant.compare(a, b)

export const makeTimeSlot: (
  start: Temporal.Instant,
  end: Temporal.Instant,
) => Either.Either<TimeSlot, DomainError> = intervalSmartCtor<Temporal.Instant, DomainError>(
  cmpInstant,
  () => new InvalidTimeSlotError({ reason: "start must precede end" }),
)

/** Duration of the slot in whole minutes (rounds down). */
export const durationMinutes = (slot: TimeSlot): number => {
  const ns = slot.end.epochNanoseconds - slot.start.epochNanoseconds
  return Number(ns / 60_000_000_000n)
}

/** True iff `a` and `b` overlap. Touching boundaries (a.end === b.start) do not overlap. */
export const overlaps = overlapsBy(cmpInstant)

/** True iff `slot` is fully contained within `[start, end)`. */
export const containedIn = containedInBy(cmpInstant)
