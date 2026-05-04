import { Either, Schema } from "effect"
import { type DomainError, InvalidHoldingDaysError } from "../errors/Errors.js"
import { summarizeParse } from "../errors/fromParseError.js"

const MAX_DAYS = 30

/**
 * Days a Resource stays occupied after the work is performed. `0`
 * means same-day completion (no carry-over). Capped at 30; Phase 0
 * does not address services that occupy a Resource for longer.
 */
export const HoldingDaysSchema = Schema.Number.pipe(
  Schema.int(),
  Schema.between(0, MAX_DAYS),
  Schema.brand("HoldingDays"),
)
export type HoldingDays = Schema.Schema.Type<typeof HoldingDaysSchema>

const isHoldingDaysSchema = Schema.is(HoldingDaysSchema)

export const isHoldingDays = (n: number): n is HoldingDays => isHoldingDaysSchema(n)

const decode = Schema.decodeUnknownEither(HoldingDaysSchema)

export const parseHoldingDays = (n: number): Either.Either<HoldingDays, DomainError> =>
  Either.mapLeft(decode(n), (e) => new InvalidHoldingDaysError({ reason: summarizeParse(e) }))
