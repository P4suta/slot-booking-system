import { Either } from "effect"
import { type DomainError, InvalidPhoneLast4Error } from "../errors/Errors.js"
import type { Brand } from "../types/Brand.js"

/**
 * Last four digits of a customer phone number — the **only** phone-number
 * surface this system stores. Combined with `BookingCode` it acts as a
 * weak authorisation factor for self-service cancel / reschedule.
 */
export type PhoneLast4 = Brand<string, "PhoneLast4">

const PHONE_LAST4_PATTERN = /^\d{4}$/

export const isPhoneLast4 = (value: string): value is PhoneLast4 => PHONE_LAST4_PATTERN.test(value)

export const parsePhoneLast4 = (value: string): Either.Either<PhoneLast4, DomainError> =>
  isPhoneLast4(value)
    ? Either.right(value)
    : Either.left(new InvalidPhoneLast4Error({ reason: "must be exactly 4 ASCII digits" }))
