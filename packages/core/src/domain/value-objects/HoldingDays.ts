import { Either } from "effect"
import { type DomainError, InvalidHoldingDaysError } from "../errors/Errors.js"
import type { Brand } from "../types/Brand.js"

/**
 * Days a Resource stays occupied after the work is performed. `0`
 * means same-day completion (no carry-over). Capped at 30; Phase 0
 * does not address services that occupy a Resource for longer.
 */
export type HoldingDays = Brand<number, "HoldingDays">

const MAX_DAYS = 30

export const isHoldingDays = (n: number): n is HoldingDays =>
  Number.isInteger(n) && n >= 0 && n <= MAX_DAYS

export const parseHoldingDays = (n: number): Either.Either<HoldingDays, DomainError> =>
  isHoldingDays(n)
    ? Either.right(n)
    : Either.left(new InvalidHoldingDaysError({ reason: `must be an integer in [0, ${MAX_DAYS}]` }))
