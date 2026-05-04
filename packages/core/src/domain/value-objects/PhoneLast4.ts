import { Either, Schema } from "effect"
import { type DomainError, InvalidPhoneLast4Error } from "../errors/Errors.js"
import { summarizeParse } from "../errors/fromParseError.js"

/**
 * Last four digits of a customer phone number — the **only** phone-number
 * surface this system stores. Combined with `BookingCode` it acts as a
 * weak authorisation factor for self-service cancel / reschedule.
 */
export const PhoneLast4Schema = Schema.String.pipe(
  Schema.pattern(/^\d{4}$/),
  Schema.brand("PhoneLast4"),
)
export type PhoneLast4 = Schema.Schema.Type<typeof PhoneLast4Schema>

const isPhoneLast4Schema = Schema.is(PhoneLast4Schema)

export const isPhoneLast4 = (value: string): value is PhoneLast4 => isPhoneLast4Schema(value)

const decode = Schema.decodeUnknownEither(PhoneLast4Schema)

export const parsePhoneLast4 = (value: unknown): Either.Either<PhoneLast4, DomainError> =>
  Either.mapLeft(decode(value), (e) => new InvalidPhoneLast4Error({ reason: summarizeParse(e) }))
