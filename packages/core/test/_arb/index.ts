import { Schema } from "effect"
import * as fc from "fast-check"
import type { CustomerHandle } from "../../src/domain/value-objects/CustomerHandle.js"
import { NameKanaSchema } from "../../src/domain/value-objects/NameKana.js"
import { PhoneLast4Schema } from "../../src/domain/value-objects/PhoneLast4.js"

/**
 * Shared fast-check arbitraries for property tests across
 * `packages/core/test/`. Sourced once here so the same generators
 * exercise the queue domain regardless of which test file pulls
 * them in.
 *
 * Convention: every arb returns values that are *valid* by domain
 * rules (would survive boundary parsing). Negative cases are
 * generated inline at the call site so the property statement
 * carries its own falsification surface.
 */

/** Full-width katakana name + space, length 2..16. */
const arbNameKanaText: fc.Arbitrary<string> = fc
  .integer({ min: 2, max: 16 })
  .chain((n) =>
    fc.array(fc.constantFrom("ア", "カ", "サ", "タ", "ナ", "ハ", "マ", "ヤ", "ラ", "ワ", "ン"), {
      minLength: n,
      maxLength: n,
    }),
  )
  .map((cs) => cs.join(""))

/** Four-digit string. */
const arbPhoneLast4: fc.Arbitrary<string> = fc
  .integer({ min: 0, max: 9999 })
  .map((n) => n.toString().padStart(4, "0"))

/** A {@link CustomerHandle} that is guaranteed to survive the boundary parser. */
export const arbCustomerHandle: fc.Arbitrary<CustomerHandle> = fc
  .tuple(arbNameKanaText, arbPhoneLast4)
  .map(([kana, p4]) => ({
    nameKana: Schema.decodeUnknownSync(NameKanaSchema)(kana),
    phoneLast4: Schema.decodeUnknownSync(PhoneLast4Schema)(p4),
  }))

/**
 * Lifecycle command labels for the `fc.commands` state-machine
 * test. Every command knows whether it is enabled given the
 * current model — see `ticket-lifecycle.property.test.ts`.
 */
export type LifecycleCommand =
  | "issue"
  | "callNext"
  | "markServed"
  | "markNoShow"
  | "recall"
  | "cancel"

export const arbLifecycleCommand: fc.Arbitrary<LifecycleCommand> = fc.constantFrom(
  "issue",
  "callNext",
  "markServed",
  "markNoShow",
  "recall",
  "cancel",
)
