import { Either } from "effect"
import * as fc from "fast-check"
import { describe, expect, it } from "vitest"
import { parseBookingCode } from "../../src/domain/value-objects/BookingCode.js"
import { parseNameKana } from "../../src/domain/value-objects/NameKana.js"
import { parsePhoneLast4 } from "../../src/domain/value-objects/PhoneLast4.js"

/**
 * Phase 0.7-γ2 — boundary-parser fuzz suite. Every parser at the
 * application's outer surface (BookingCode, NameKana, PhoneLast4)
 * must accept *any* `string` (or `unknown` for the wide-input
 * variant) without throwing. Adversarial inputs that fail
 * validation come back as `Either.left(DomainError)`; the parsers
 * never `throw`, never crash on malformed UTF-8, never enter an
 * unbounded loop.
 *
 * The property is deliberately weak (no shape assertion on the
 * `Right` value) — this is a robustness test, not a correctness
 * test. Specific parser semantics are covered by their dedicated
 * test suites.
 */

const isEither = (r: unknown): boolean =>
  typeof r === "object" && r !== null && "_tag" in r && (r._tag === "Right" || r._tag === "Left")

describe("boundary parser fuzz (parseBookingCode)", () => {
  it("never throws on a random unicode string", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme" }), (raw) => {
        const result = parseBookingCode(raw)
        expect(isEither(result)).toBe(true)
      }),
      { numRuns: 500 },
    )
  })

  it("never throws on a random ASCII string", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 32 }), (raw) => {
        const result = parseBookingCode(raw)
        expect(isEither(result)).toBe(true)
      }),
      { numRuns: 500 },
    )
  })

  it("decoded values match the canonical 7-char Crockford+checksum shape", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme" }), (raw) => {
        const result = parseBookingCode(raw)
        if (Either.isRight(result)) {
          expect(result.right).toMatch(/^[0-9A-Z*~$=U]{7}$/)
        }
        return true
      }),
      { numRuns: 500 },
    )
  })
})

describe("boundary parser fuzz (parseNameKana)", () => {
  it("never throws on a random unicode string", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme" }), (raw) => {
        const result = parseNameKana(raw)
        expect(isEither(result)).toBe(true)
      }),
      { numRuns: 500 },
    )
  })
})

describe("boundary parser fuzz (parsePhoneLast4)", () => {
  it("never throws on arbitrary unknown input", () => {
    fc.assert(
      fc.property(fc.anything(), (raw) => {
        const result = parsePhoneLast4(raw)
        expect(isEither(result)).toBe(true)
      }),
      { numRuns: 500 },
    )
  })
})
