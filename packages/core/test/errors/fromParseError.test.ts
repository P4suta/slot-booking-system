import { Result, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { summarizeParse } from "../../src/domain/errors/fromParseError.js"

const FourDigits = Schema.String.check(Schema.isPattern(/^\d{4}$/)).pipe(Schema.brand("FourDigits"))
const decodeFourDigits = Schema.decodeUnknownResult(FourDigits)

const Person = Schema.Struct({
  age: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 150 })),
  name: Schema.String.check(Schema.isMinLength(1)),
})
const decodePerson = Schema.decodeUnknownResult(Person)

describe("summarizeParse", () => {
  it("returns the deepest leaf for a refinement failure on a string", () => {
    const result = decodeFourDigits("abc")
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      const reason = summarizeParse(result.failure)
      expect(reason).toContain("Expected")
      expect(reason).toContain("abc")
      expect(reason).not.toContain("\n")
    }
  })

  it("returns the deepest leaf when the input is the wrong primitive type", () => {
    const result = decodeFourDigits(1234)
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      const reason = summarizeParse(result.failure)
      expect(reason).toContain("Expected string")
      expect(reason).toContain("1234")
      expect(reason).not.toContain("\n")
    }
  })

  it("returns the leaf cause from a nested struct failure (path is dropped)", () => {
    const result = decodePerson({ age: -5, name: "ok" })
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      const reason = summarizeParse(result.failure)
      expect(reason).toContain("Expected a value between 0 and 150")
      expect(reason).toContain("-5")
      expect(reason).not.toContain("\n")
    }
  })

  it("handles the empty-string case (still returns a non-empty leaf)", () => {
    const result = decodeFourDigits("")
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      const reason = summarizeParse(result.failure)
      expect(reason.length).toBeGreaterThan(0)
      expect(reason).not.toContain("\n")
    }
  })
})
