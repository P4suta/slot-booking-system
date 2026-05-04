import { Temporal } from "@js-temporal/polyfill"
import { Either } from "effect"
import { type DomainError, InvalidBusinessTimeZone } from "../errors/DomainError.js"
import type { Brand } from "../types/Brand.js"

/**
 * IANA time-zone identifier of the deployment, branded so it cannot
 * be confused with an arbitrary string. Validated by round-tripping
 * through `Temporal.TimeZone.from`.
 */
export type BusinessTimeZone = Brand<string, "BusinessTimeZone">

export const parseBusinessTimeZone = (
  raw: string,
): Either.Either<BusinessTimeZone, DomainError> => {
  try {
    const _check = Temporal.Now.zonedDateTimeISO(raw)
    void _check
    return Either.right(raw as BusinessTimeZone)
  } catch {
    return Either.left(InvalidBusinessTimeZone(raw))
  }
}
