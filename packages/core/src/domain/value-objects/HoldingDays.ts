import { Result, Schema } from "effect"
import { type DomainError, InvalidHoldingDaysError } from "../errors/Errors.js"
import { summarizeParse } from "../errors/fromParseError.js"

const MAX_DAYS = 30

/**
 * Days a Resource stays occupied after the work is performed. `0`
 * means same-day completion (no carry-over). Capped at 30; Phase 0
 * does not address services that occupy a Resource for longer.
 */
export const HoldingDaysSchema = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 0, maximum: MAX_DAYS }),
).pipe(Schema.brand("HoldingDays"))
export type HoldingDays = Schema.Schema.Type<typeof HoldingDaysSchema>

const isHoldingDaysSchema = Schema.is(HoldingDaysSchema)

export const isHoldingDays = (n: number): n is HoldingDays => isHoldingDaysSchema(n)

const decode = Schema.decodeUnknownResult(HoldingDaysSchema)

export const parseHoldingDays = (n: number): Result.Result<HoldingDays, DomainError> =>
  Result.mapError(decode(n), (e) => new InvalidHoldingDaysError({ reason: summarizeParse(e) }))
