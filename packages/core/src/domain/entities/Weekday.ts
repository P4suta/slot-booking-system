import { Result, Schema } from "effect"
import { type DomainError, InvalidWeekdayError } from "../errors/Errors.js"

/**
 * ISO 8601 weekday: 1 = Monday, …, 7 = Sunday. Matches
 * `Temporal.PlainDate#dayOfWeek` so day-of-week lookups don't need
 * conversion.
 */
export const WeekdaySchema = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1, maximum: 7 }),
).pipe(Schema.brand("Weekday"))
export type Weekday = Schema.Schema.Type<typeof WeekdaySchema>

const isWeekdaySchema = Schema.is(WeekdaySchema)

export const isWeekday = (n: number): n is Weekday => isWeekdaySchema(n)

const decode = Schema.decodeUnknownResult(WeekdaySchema)

export const parseWeekday = (n: number): Result.Result<Weekday, DomainError> =>
  Result.mapError(
    decode(n),
    () => new InvalidWeekdayError({ reason: "weekday must be 1..7 (Mon..Sun)" }),
  )
