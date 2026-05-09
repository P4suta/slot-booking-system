import { Result, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { firstFailedFieldKey, summarizeParse } from "../../src/domain/errors/fromParseError.js"

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

const HandleStruct = Schema.Struct({
  nameKana: Schema.String.check(Schema.isMinLength(1)),
  phoneLast4: Schema.String.check(Schema.isPattern(/^\d{4}$/)),
})
const decodeHandle = Schema.decodeUnknownResult(HandleStruct)

describe("firstFailedFieldKey", () => {
  it("extracts the failing struct key from a Composite > Pointer issue", () => {
    const result = decodeHandle({ nameKana: "ヤマダ", phoneLast4: "abcd" })
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(firstFailedFieldKey(result.failure)).toBe("phoneLast4")
    }
  })

  it("returns the *first* failing key when both fields fail (struct-key order)", () => {
    const result = decodeHandle({ nameKana: "", phoneLast4: "abcd" })
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      // Struct field iteration order: nameKana first, phoneLast4 second.
      expect(firstFailedFieldKey(result.failure)).toBe("nameKana")
    }
  })

  it("descends through a Filter wrapper to the inner Pointer", () => {
    // `brandedString`-style branded schema wraps a Filter on top of
    // the struct-aware refinement. Stress the Filter -> Composite ->
    // Pointer descent path.
    const Branded = HandleStruct.pipe(
      Schema.brand("Handle"),
      Schema.check(Schema.makeFilter((h) => h.nameKana !== "BANNED")),
    )
    const decode = Schema.decodeUnknownResult(Branded)
    const result = decode({ nameKana: "ヤマダ", phoneLast4: "1ab2" })
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(firstFailedFieldKey(result.failure)).toBe("phoneLast4")
    }
  })

  it("returns undefined for a top-level type mismatch (no path)", () => {
    const result = decodeHandle("not-an-object")
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(firstFailedFieldKey(result.failure)).toBeUndefined()
    }
  })

  it("returns undefined for a Leaf issue (primitive type mismatch)", () => {
    const result = decodeFourDigits(1234)
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(firstFailedFieldKey(result.failure)).toBeUndefined()
    }
  })

  it("walks AnyOf children — union member failure surfaces the inner key", () => {
    const Union = Schema.Union([
      Schema.Struct({ a: Schema.String.check(Schema.isMinLength(1)) }),
      Schema.Struct({ b: Schema.String.check(Schema.isMinLength(1)) }),
    ])
    const decode = Schema.decodeUnknownResult(Union)
    const result = decode({ a: "" })
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      // `a` is the first union member; its Pointer["a"] surfaces.
      expect(firstFailedFieldKey(result.failure)).toBe("a")
    }
  })

  it("returns undefined when the path head is a non-string (e.g. tuple index)", () => {
    const Tuple = Schema.Tuple([Schema.String.check(Schema.isMinLength(1)), Schema.String])
    const decode = Schema.decodeUnknownResult(Tuple)
    const result = decode(["", "ok"])
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      // Tuple Pointer carries a numeric index; the helper only
      // surfaces *string* heads (struct keys), so a numeric index
      // recurses inward and the inner Filter leaf yields undefined.
      expect(firstFailedFieldKey(result.failure)).toBeUndefined()
    }
  })
})
