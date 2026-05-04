import { Either, Schema } from "effect"
import { type DomainError, InvalidDurationError } from "../errors/Errors.js"
import { summarizeParse } from "../errors/fromParseError.js"

const MAX_MINUTES = 24 * 60

/**
 * A non-negative count of minutes. Used for service work durations and
 * pre/post buffers. Capped at 24 × 60 = 1440 to keep slot bitmaps
 * within a single-day allocation (ADR-0012).
 */
export const MinutesSchema = Schema.Number.pipe(
  Schema.int(),
  Schema.between(0, MAX_MINUTES),
  Schema.brand("Minutes"),
)
export type Minutes = Schema.Schema.Type<typeof MinutesSchema>

const isMinutesSchema = Schema.is(MinutesSchema)

export const isMinutes = (n: number): n is Minutes => isMinutesSchema(n)

const decode = Schema.decodeUnknownEither(MinutesSchema)

export const parseMinutes = (n: number): Either.Either<Minutes, DomainError> =>
  Either.mapLeft(decode(n), (e) => new InvalidDurationError({ reason: summarizeParse(e) }))

/** Construction without validation, for callers that already produced a clamped integer. */
export const minutesUnchecked = (n: number): Minutes => n as Minutes
