import { Either, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { summarizeParse } from "../../src/domain/errors/fromParseError.js"

const FourDigits = Schema.String.pipe(Schema.pattern(/^\d{4}$/), Schema.brand("FourDigits"))
const decodeFourDigits = Schema.decodeUnknownEither(FourDigits)

const Person = Schema.Struct({
  age: Schema.Number.pipe(Schema.int(), Schema.between(0, 150)),
  name: Schema.String.pipe(Schema.minLength(1)),
})
const decodePerson = Schema.decodeUnknownEither(Person)

describe("summarizeParse", () => {
  it("returns the deepest leaf for a refinement failure on a string", () => {
    const result = decodeFourDigits("abc")
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      const reason = summarizeParse(result.left)
      expect(reason).toContain("Expected")
      expect(reason).toContain("abc")
      expect(reason).not.toContain("\n")
    }
  })

  it("returns the deepest leaf when the input is the wrong primitive type", () => {
    const result = decodeFourDigits(1234)
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      const reason = summarizeParse(result.left)
      expect(reason).toContain("Expected string")
      expect(reason).toContain("1234")
      expect(reason).not.toContain("\n")
    }
  })

  it("returns the leaf cause from a nested struct failure (path is dropped)", () => {
    const result = decodePerson({ age: -5, name: "ok" })
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      const reason = summarizeParse(result.left)
      expect(reason).toContain("Expected a number between 0 and 150")
      expect(reason).toContain("-5")
      expect(reason).not.toContain("\n")
    }
  })

  it("handles the empty-string case (still returns a non-empty leaf)", () => {
    const result = decodeFourDigits("")
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      const reason = summarizeParse(result.left)
      expect(reason.length).toBeGreaterThan(0)
      expect(reason).not.toContain("\n")
    }
  })
})
