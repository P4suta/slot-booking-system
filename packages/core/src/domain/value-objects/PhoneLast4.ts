import { Schema } from "effect"
import { InvalidPhoneLast4Error } from "../errors/Errors.js"
import { brandedString } from "./_brandedString.js"

/**
 * Last four digits of a customer phone number — the **only** phone-number
 * surface this system stores. Combined with `BookingCode` it acts as a
 * weak authorisation factor for self-service cancel / reschedule.
 */
const phoneLast4 = brandedString({
  brand: "PhoneLast4",
  pattern: /^\d{4}$/,
  errorClass: InvalidPhoneLast4Error,
})

export const PhoneLast4Schema = phoneLast4.schema
export type PhoneLast4 = Schema.Schema.Type<typeof PhoneLast4Schema>

const isPhoneLast4Schema = Schema.is(PhoneLast4Schema)
export const isPhoneLast4 = (value: string): value is PhoneLast4 => isPhoneLast4Schema(value)

export const parsePhoneLast4 = phoneLast4.parse
