import { Temporal } from "@js-temporal/polyfill"
import { Either, Schema } from "effect"
import { type DomainError, InvalidTimeSlotError } from "../errors/Errors.js"
import { InstantSchema } from "../types/Temporal.js"

/**
 * `[start, end)` half-open interval over UTC instants. The minimum
 * duration is 1 minute; the maximum is the configured per-day cap
 * enforced by `Minutes` (ADR-0004).
 */
export const TimeSlotSchema = Schema.Struct({
  start: InstantSchema,
  end: InstantSchema,
})
export type TimeSlot = Schema.Schema.Type<typeof TimeSlotSchema>

const cmp = (a: Temporal.Instant, b: Temporal.Instant): number => Temporal.Instant.compare(a, b)

export const makeTimeSlot = (
  start: Temporal.Instant,
  end: Temporal.Instant,
): Either.Either<TimeSlot, DomainError> => {
  if (cmp(start, end) >= 0) {
    return Either.left(new InvalidTimeSlotError({ reason: "start must precede end" }))
  }
  return Either.right({ start, end })
}

/** Duration of the slot in whole minutes (rounds down). */
export const durationMinutes = (slot: TimeSlot): number => {
  const ns = slot.end.epochNanoseconds - slot.start.epochNanoseconds
  return Number(ns / 60_000_000_000n)
}

/** True iff `a` and `b` overlap. Touching boundaries (a.end === b.start) do not overlap. */
export const overlaps = (a: TimeSlot, b: TimeSlot): boolean =>
  cmp(a.start, b.end) < 0 && cmp(b.start, a.end) < 0

/** True iff `slot` is fully contained within `[start, end)`. */
export const containedIn = (slot: TimeSlot, bounds: TimeSlot): boolean =>
  cmp(slot.start, bounds.start) >= 0 && cmp(slot.end, bounds.end) <= 0
