import { Either } from "effect"
import { type DomainError, InvalidDurationError } from "../errors/Errors.js"
import type { Brand } from "../types/Brand.js"

/**
 * A non-negative count of minutes. Used for service work durations and
 * pre/post buffers. Capped at 24 × 60 = 1440 to keep slot bitmaps
 * within a single-day allocation (ADR-0012).
 */
export type Minutes = Brand<number, "Minutes">

const MAX_MINUTES = 24 * 60

export const isMinutes = (n: number): n is Minutes =>
  Number.isInteger(n) && n >= 0 && n <= MAX_MINUTES

export const parseMinutes = (n: number): Either.Either<Minutes, DomainError> =>
  isMinutes(n)
    ? Either.right(n)
    : Either.left(new InvalidDurationError({ reason: `must be an integer in [0, ${MAX_MINUTES}]` }))

/** Construction without validation, for callers that already produced a clamped integer. */
export const minutesUnchecked = (n: number): Minutes => n as Minutes
