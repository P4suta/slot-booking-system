import { Result, Schema } from "effect"
import type { DomainError } from "../errors/Errors.js"
import { type NameKana, NameKanaSchema, parseNameKana } from "./NameKana.js"
import { type PhoneLast4, PhoneLast4Schema, parsePhoneLast4 } from "./PhoneLast4.js"

/**
 * Anonymous customer identity for the queue domain (ADR-0054). The
 * `(nameKana, phoneLast4)` pair is the weakest credential that still
 * keeps a ticket-id enumeration attack from mutating someone else's
 * waiting position: an attacker who guesses a valid `TicketId` still
 * cannot cancel the ticket without the matching name-kana / last-4.
 *
 * No session, no cookie, no account. The frontend keeps the handle in
 * a URL fragment (`#name=…&p=…`) which never reaches the worker logs;
 * the worker accepts the handle on every mutation and verifies it
 * against the ticket's stored kana / phone-last-4.
 */
export const CustomerHandleSchema = Schema.Struct({
  nameKana: NameKanaSchema,
  phoneLast4: PhoneLast4Schema,
})
export type CustomerHandle = Schema.Schema.Type<typeof CustomerHandleSchema>

/**
 * Lift two raw strings (typically form input) into a validated
 * {@link CustomerHandle}. Returns `Failure` with the first VO error
 * encountered — the call site renders the user-facing message via
 * the standard `errorToI18nKey` projection.
 */
export const parseCustomerHandle = (
  nameKana: string,
  phoneLast4: string,
): Result.Result<CustomerHandle, DomainError> => {
  const kanaR = parseNameKana(nameKana)
  if (Result.isFailure(kanaR)) return Result.fail<CustomerHandle, DomainError>(kanaR.failure)
  const phoneR = parsePhoneLast4(phoneLast4)
  if (Result.isFailure(phoneR)) return Result.fail<CustomerHandle, DomainError>(phoneR.failure)
  return Result.succeed<CustomerHandle, DomainError>({
    nameKana: kanaR.success,
    phoneLast4: phoneR.success,
  })
}

/**
 * Equality on the structural pair. Two handles match iff both
 * components are equal as branded scalars (string equality after
 * normalisation has already happened during parsing).
 */
export const equalsCustomerHandle = (a: CustomerHandle, b: CustomerHandle): boolean =>
  (a.nameKana as string) === (b.nameKana as string) &&
  (a.phoneLast4 as string) === (b.phoneLast4 as string)

export type { NameKana, PhoneLast4 }
