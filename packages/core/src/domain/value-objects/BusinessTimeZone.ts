import { Temporal } from "@js-temporal/polyfill"
import { Result, Schema } from "effect"
import { type DomainError, InvalidBusinessTimeZoneError } from "../errors/Errors.js"

const isValidIanaTimeZone = (s: string): boolean => {
  try {
    Temporal.Now.zonedDateTimeISO(s)
    return true
  } catch {
    return false
  }
}

/**
 * IANA time-zone identifier of the deployment, branded so it cannot
 * be confused with an arbitrary string. Validated by round-tripping
 * through `Temporal.Now.zonedDateTimeISO`, which throws on unknown
 * zones.
 */
export const BusinessTimeZoneSchema = Schema.String.check(
  Schema.makeFilter(isValidIanaTimeZone),
).pipe(Schema.brand("BusinessTimeZone"))
export type BusinessTimeZone = Schema.Schema.Type<typeof BusinessTimeZoneSchema>

const decode = Schema.decodeUnknownResult(BusinessTimeZoneSchema)

export const parseBusinessTimeZone = (raw: string): Result.Result<BusinessTimeZone, DomainError> =>
  Result.mapError(decode(raw), () => new InvalidBusinessTimeZoneError({ value: raw }))
