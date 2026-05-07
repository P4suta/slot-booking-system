import { Result, Schema } from "effect"
import { type DomainError, InvalidDurationError } from "../errors/Errors.js"
import { summarizeParse } from "../errors/fromParseError.js"

const MAX_MINUTES = 24 * 60

/**
 * A non-negative count of minutes. Used for service work durations and
 * pre/post buffers. Capped at 24 × 60 = 1440 to keep slot bitmaps
 * within a single-day allocation (ADR-0012).
 */
export const MinutesSchema = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 0, maximum: MAX_MINUTES }),
).pipe(Schema.brand("Minutes"))
export type Minutes = Schema.Schema.Type<typeof MinutesSchema>

const isMinutesSchema = Schema.is(MinutesSchema)

export const isMinutes = (n: number): n is Minutes => isMinutesSchema(n)

const decode = Schema.decodeUnknownResult(MinutesSchema)

export const parseMinutes = (n: number): Result.Result<Minutes, DomainError> =>
  Result.mapError(decode(n), (e) => new InvalidDurationError({ reason: summarizeParse(e) }))

/** Construction without validation, for callers that already produced a clamped integer. */
export const minutesUnchecked = (n: number): Minutes => n as Minutes
