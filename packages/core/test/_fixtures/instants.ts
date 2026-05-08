import { Temporal } from "@js-temporal/polyfill"
import { Result } from "effect"
import { makeTimeSlot, type TimeSlot } from "../../src/domain/value-objects/TimeSlot.js"

/** Parse an ISO-8601 instant string. */
export const at = (iso: string): Temporal.Instant => Temporal.Instant.from(iso)

/** Build a `Temporal.PlainTime` from `(hour, minute)`. */
export const t = (hour: number, minute = 0): Temporal.PlainTime =>
  Temporal.PlainTime.from({ hour, minute })

/** Build a `Temporal.PlainDate` from an ISO date string. */
export const date = (iso: string): Temporal.PlainDate => Temporal.PlainDate.from(iso)

/** Build a `TimeSlot` from two ISO instants; throws if `start >= end` (test-only). */
export const slot = (startIso: string, endIso: string): TimeSlot =>
  Result.getOrThrow(makeTimeSlot(at(startIso), at(endIso)))
