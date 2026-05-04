import { Temporal } from "@js-temporal/polyfill"
import { Either, Schema } from "effect"
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
export const BusinessTimeZoneSchema = Schema.String.pipe(
  Schema.filter(isValidIanaTimeZone),
  Schema.brand("BusinessTimeZone"),
)
export type BusinessTimeZone = Schema.Schema.Type<typeof BusinessTimeZoneSchema>

const decode = Schema.decodeUnknownEither(BusinessTimeZoneSchema)

export const parseBusinessTimeZone = (raw: string): Either.Either<BusinessTimeZone, DomainError> =>
  Either.mapLeft(decode(raw), () => new InvalidBusinessTimeZoneError({ value: raw }))
