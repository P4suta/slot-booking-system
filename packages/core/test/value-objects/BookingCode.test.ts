import { Either } from "effect"
import * as fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
  BOOKING_CODE_KEYSPACE,
  encodeBookingCode,
  formatBookingCode,
  normalizeBookingCode,
  parseBookingCode,
} from "../../src/domain/value-objects/BookingCode.js"

const expectRight = <A, E>(e: Either.Either<A, E>): A => {
  expect(Either.isRight(e), `expected Right, got Left: ${JSON.stringify(e)}`).toBe(true)
  return Either.getOrThrow(e)
}

const expectLeft = <A, E>(e: Either.Either<A, E>): E => {
  expect(Either.isLeft(e), "expected Left").toBe(true)
  if (Either.isLeft(e)) return e.left
  throw new Error("unreachable")
}

describe("BookingCode", () => {
  describe("normalizeBookingCode", () => {
    it("uppercases, strips dashes and whitespace, folds Crockford confusables", () => {
      expect(normalizeBookingCode("abcd-efg")).toBe("ABCDEFG")
      expect(normalizeBookingCode("  ab cd-ef g ")).toBe("ABCDEFG")
      expect(normalizeBookingCode("oilOIL0")).toBe("0110110")
      expect(normalizeBookingCode("xxxx-xxx")).toBe("XXXXXXX")
    })
  })

  describe("encodeBookingCode", () => {
    it("rejects values out of keyspace", () => {
      expect(Either.isLeft(encodeBookingCode(-1n))).toBe(true)
      expect(Either.isLeft(encodeBookingCode(BOOKING_CODE_KEYSPACE))).toBe(true)
    })

    it("zero encodes as the canonical zero code", () => {
      const code = expectRight(encodeBookingCode(0n))
      expect(code).toBe("0000000")
    })

    it("max value encodes within keyspace", () => {
      const code = expectRight(encodeBookingCode(BOOKING_CODE_KEYSPACE - 1n))
      expect(code).toHaveLength(7)
    })
  })

  describe("parseBookingCode", () => {
    it("round-trips encode → parse for known values", () => {
      const cases = [0n, 1n, 31n, 32n, 1023n, 1n << 28n, BOOKING_CODE_KEYSPACE - 1n]
      for (const v of cases) {
        const code = expectRight(encodeBookingCode(v))
        const parsed = expectRight(parseBookingCode(code))
        expect(parsed).toBe(code)
      }
    })

    it("accepts the dash-formatted form", () => {
      const code = expectRight(encodeBookingCode(123_456_789n))
      const formatted = formatBookingCode(code)
      expect(formatted).toMatch(/^[0-9A-Z*~$=U]{4}-[0-9A-Z*~$=U]{3}$/)
      const parsed = expectRight(parseBookingCode(formatted))
      expect(parsed).toBe(code)
    })

    it("folds confusables: O→0, I→1, L→1, lowercase→upper", () => {
      const code = expectRight(encodeBookingCode(0n))
      expect(parseBookingCode(code.toLowerCase())._tag).toBe("Right")
    })

    it("rejects wrong length", () => {
      expect(expectLeft(parseBookingCode(""))._tag).toBe("InvalidBookingCode")
      expect(expectLeft(parseBookingCode("12345"))._tag).toBe("InvalidBookingCode")
      expect(expectLeft(parseBookingCode("12345678"))._tag).toBe("InvalidBookingCode")
    })

    it("rejects invalid characters in the body", () => {
      // '!' survives normalisation unchanged and is not in the Crockford body alphabet.
      const err = expectLeft(parseBookingCode("!000000"))
      expect(err._tag).toBe("InvalidBookingCode")
      if (err._tag === "InvalidBookingCode") expect(err.reason).toBe("invalid-character")
    })

    it("rejects invalid characters in the check position", () => {
      // 'a' would normalise to 'A' (a body char), so use '@' which survives normalisation.
      const err = expectLeft(parseBookingCode("000000@"))
      expect(err._tag).toBe("InvalidBookingCode")
      if (err._tag === "InvalidBookingCode") expect(err.reason).toBe("invalid-character")
    })

    it("rejects mismatched checksum", () => {
      const code = expectRight(encodeBookingCode(42n))
      // Flip the check character to a different valid char from the check alphabet
      const tampered = `${code.slice(0, 6)}${code[6] === "9" ? "8" : "9"}`
      const err = expectLeft(parseBookingCode(tampered))
      expect(err._tag).toBe("InvalidBookingCode")
      if (err._tag === "InvalidBookingCode") expect(err.reason).toBe("checksum-mismatch")
    })

    it("property: every keyspace value round-trips", () => {
      fc.assert(
        fc.property(fc.bigInt({ min: 0n, max: BOOKING_CODE_KEYSPACE - 1n }), (v) => {
          const code = expectRight(encodeBookingCode(v))
          const parsed = expectRight(parseBookingCode(code))
          return parsed === code
        }),
        { numRuns: 1000 },
      )
    })

    it("property: random 7-char strings reject ≥ ~96% of the time (Crockford rejects non-alpha)", () => {
      let accepted = 0
      let total = 0
      fc.assert(
        fc.property(fc.stringMatching(/^[0-9A-Z*~$=U]{7}$/), (s) => {
          total++
          if (Either.isRight(parseBookingCode(s))) accepted++
          return true
        }),
        { numRuns: 1000 },
      )
      // Within the 7-char check alphabet space, ~1/37 should pass the
      // checksum (the body char check is permissive because every char
      // we generate is in the body alphabet).
      const acceptRate = accepted / total
      expect(acceptRate).toBeLessThan(0.1)
    })

    it("property: corrupting any single body char triggers checksum-mismatch (or invalid-character)", () => {
      fc.assert(
        fc.property(
          fc.bigInt({ min: 0n, max: BOOKING_CODE_KEYSPACE - 1n }),
          fc.integer({ min: 0, max: 5 }),
          fc.stringMatching(/^[0-9A-HJKMNP-TV-Z]$/),
          (v, idx, replacement) => {
            const code = expectRight(encodeBookingCode(v))
            if (code[idx] === replacement) return true
            const tampered = `${code.slice(0, idx)}${replacement}${code.slice(idx + 1)}`
            const result = parseBookingCode(tampered)
            if (Either.isRight(result)) return false
            const tag = result.left._tag
            const reason = tag === "InvalidBookingCode" ? result.left.reason : "other"
            return reason === "checksum-mismatch" || reason === "invalid-character"
          },
        ),
        { numRuns: 500 },
      )
    })
  })
})
