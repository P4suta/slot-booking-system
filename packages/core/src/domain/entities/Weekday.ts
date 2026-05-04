import { Either } from "effect"
import { type DomainError, InvalidWeekdayError } from "../errors/Errors.js"
import type { Brand } from "../types/Brand.js"

/**
 * ISO 8601 weekday: 1 = Monday, …, 7 = Sunday. Matches
 * `Temporal.PlainDate#dayOfWeek` so day-of-week lookups don't need
 * conversion.
 */
export type Weekday = Brand<number, "Weekday">

export const isWeekday = (n: number): n is Weekday => Number.isInteger(n) && n >= 1 && n <= 7

export const parseWeekday = (n: number): Either.Either<Weekday, DomainError> =>
  isWeekday(n)
    ? Either.right(n)
    : Either.left(new InvalidWeekdayError({ reason: "weekday must be 1..7 (Mon..Sun)" }))
