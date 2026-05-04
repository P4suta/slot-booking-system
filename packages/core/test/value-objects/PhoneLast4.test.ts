import { Either } from "effect"
import * as fc from "fast-check"
import { describe, expect, it } from "vitest"
import { isPhoneLast4, parsePhoneLast4 } from "../../src/domain/value-objects/PhoneLast4.js"

describe("PhoneLast4", () => {
  describe("isPhoneLast4", () => {
    it("accepts 4 ASCII digits", () => {
      expect(isPhoneLast4("0000")).toBe(true)
      expect(isPhoneLast4("9999")).toBe(true)
      expect(isPhoneLast4("1234")).toBe(true)
    })

    it.each([
      ["empty", ""],
      ["3 digits", "123"],
      ["5 digits", "12345"],
      ["letters", "12a4"],
      ["full-width", "１２３４"],
      ["whitespace", "12 4"],
      ["leading sign", "+234"],
      ["with newline", "1234\n"],
    ])("rejects %s", (_label, input) => {
      expect(isPhoneLast4(input)).toBe(false)
    })
  })

  describe("parsePhoneLast4", () => {
    it("returns Right with the branded value on success", () => {
      const result = parsePhoneLast4("4567")
      expect(Either.isRight(result)).toBe(true)
      if (Either.isRight(result)) {
        expect(result.right).toBe("4567")
      }
    })

    it("returns Left with an InvalidPhoneLast4 error on failure", () => {
      const result = parsePhoneLast4("abcd")
      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) {
        expect(result.left._tag).toBe("InvalidPhoneLast4")
      }
    })

    it("property: any 4-digit string round-trips and any other string is rejected", () => {
      fc.assert(
        fc.property(fc.string(), (s) => {
          const result = parsePhoneLast4(s)
          if (/^\d{4}$/.test(s)) {
            return Either.isRight(result) && Either.getOrThrow(result) === s
          }
          return Either.isLeft(result)
        }),
        { numRuns: 1000 },
      )
    })
  })
})
