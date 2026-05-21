import { Result, Schema } from "effect"
import type { NonEmptyReadonlyArray } from "effect/Array"
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
 * {@link CustomerHandle} with **error accumulation**: both fields
 * are parsed independently and every failure is reported, so a UI
 * showing the form errors next to each input gets the full set on
 * a single submit. The boundary parser favours operator-friendly
 * feedback over fail-fast cost.
 */
export const parseCustomerHandle = (
  nameKana: string,
  phoneLast4: string,
): Result.Result<CustomerHandle, NonEmptyReadonlyArray<DomainError>> => {
  const kanaR = parseNameKana(nameKana)
  const phoneR = parsePhoneLast4(phoneLast4)
  if (Result.isFailure(kanaR) && Result.isFailure(phoneR)) {
    return Result.fail([kanaR.failure, phoneR.failure])
  }
  if (Result.isFailure(kanaR)) {
    return Result.fail([kanaR.failure])
  }
  if (Result.isFailure(phoneR)) {
    return Result.fail([phoneR.failure])
  }
  return Result.succeed({ nameKana: kanaR.success, phoneLast4: phoneR.success })
}

/**
 * Fail-fast variant for adapter call sites that surface only the
 * first error (DO RPC paths, internal use cases that don't render
 * a form). Mirrors {@link parseCustomerHandle} otherwise.
 */
export const parseCustomerHandleStrict = (
  nameKana: string,
  phoneLast4: string,
): Result.Result<CustomerHandle, DomainError> => {
  const kanaR = parseNameKana(nameKana)
  if (Result.isFailure(kanaR)) return Result.fail(kanaR.failure)
  const phoneR = parsePhoneLast4(phoneLast4)
  if (Result.isFailure(phoneR)) return Result.fail(phoneR.failure)
  return Result.succeed({
    nameKana: kanaR.success,
    phoneLast4: phoneR.success,
  })
}

/**
 * Constant-time string equality folded over UTF-16 code units. The
 * length-mismatch early-exit is the only data-dependent branch and
 * runs *before* secret material reaches the comparator, matching
 * the convention `apps/default/src/server/security/timingSafeEqual.ts`
 * uses for the staff token (ADR-0058 §CWE-208). The XOR fold means
 * the loop body is independent of the secret at the branch level —
 * an attacker cannot infer prefix-match length from response timing.
 *
 * Why an inline copy lives in the domain layer: the customer
 * authentication path (`authenticateCustomer`, `equalsCustomerHandle`)
 * runs inside the core domain, which has no Workers-side
 * dependencies. The implementation is identical to the staff helper
 * and the pair is pinned to stay drift-free by the symmetric
 * matrix test (`packages/core/test/value-objects/CustomerHandle.test.ts`).
 */
export const constantTimeStringEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  // Known limitation per ADR-0058: the final `diff === 0` is a
  // single conditional jump and the XOR fold may be vectorised by
  // a sufficiently aggressive JIT. The threat model (an HTTP-level
  // attacker probing /api/v1/tickets/me under RL_VERIFY 30/min/IP)
  // makes this leakage gap unexploitable in practice. A WebCrypto
  // HMAC-based alternative would close the gap but at the cost of
  // an async API surface that does not match the synchronous
  // domain layer this helper lives in. Re-evaluate if RL_VERIFY
  // budget changes or the threat model widens.
  return diff === 0
}

/**
 * Equality on the structural pair. Two handles match iff both
 * components are equal as branded scalars (string equality after
 * normalisation has already happened during parsing).
 *
 * Both component checks always run — the operator-`||` short-circuit
 * lives at the post-evaluation `if`, after both `constantTimeStringEqual`
 * calls have returned. This closes the timing channel that would
 * otherwise distinguish "kana wrong" from "kana right + phone wrong"
 * during `/api/v1/tickets/me` brute force on the kana+last4 pair.
 */
export const equalsCustomerHandle = (a: CustomerHandle, b: CustomerHandle): boolean => {
  const kanaOK = constantTimeStringEqual(a.nameKana, b.nameKana)
  const phoneOK = constantTimeStringEqual(a.phoneLast4, b.phoneLast4)
  return kanaOK && phoneOK
}

export type { NameKana, PhoneLast4 }
