import { Either, Schema } from "effect"
import { type DomainError, InvalidWeekdayError } from "../errors/Errors.js"

/**
 * ISO 8601 weekday: 1 = Monday, …, 7 = Sunday. Matches
 * `Temporal.PlainDate#dayOfWeek` so day-of-week lookups don't need
 * conversion.
 */
export const WeekdaySchema = Schema.Number.pipe(
  Schema.int(),
  Schema.between(1, 7),
  Schema.brand("Weekday"),
)
export type Weekday = Schema.Schema.Type<typeof WeekdaySchema>

const isWeekdaySchema = Schema.is(WeekdaySchema)

export const isWeekday = (n: number): n is Weekday => isWeekdaySchema(n)

const decode = Schema.decodeUnknownEither(WeekdaySchema)

export const parseWeekday = (n: number): Either.Either<Weekday, DomainError> =>
  Either.mapLeft(
    decode(n),
    () => new InvalidWeekdayError({ reason: "weekday must be 1..7 (Mon..Sun)" }),
  )
