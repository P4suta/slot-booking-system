import { Either } from "effect"
import * as fc from "fast-check"
import { describe, expect, it } from "vitest"
import { parseMinutes } from "../../src/domain/value-objects/Duration.js"
import { normalizeFreeText, parseFreeText } from "../../src/domain/value-objects/FreeText.js"
import { parseHoldingDays } from "../../src/domain/value-objects/HoldingDays.js"
import { normalizeNameKana, parseNameKana } from "../../src/domain/value-objects/NameKana.js"

const isLeft = Either.isLeft
const isRight = Either.isRight

describe("NameKana", () => {
  it.each([
    "ヤマダ タロウ",
    "やまだ たろう",
    "ﾔﾏﾀﾞ ﾀﾛｳ",
    "サトウ",
    "サイトウ ジロウ",
  ])("accepts %s", (s) => {
    const r = parseNameKana(s)
    expect(isRight(r), `expected Right for ${JSON.stringify(s)}`).toBe(true)
  })

  it.each([
    ["empty", ""],
    ["whitespace only", "   "],
    ["latin", "Yamada Taro"],
    ["mixed kanji", "山田 太郎"],
    ["digits", "1234"],
  ])("rejects %s", (_label, input) => {
    expect(isLeft(parseNameKana(input))).toBe(true)
  })

  it("collapses whitespace and full-width spaces", () => {
    const r = parseNameKana("ヤマダ　　タロウ  ")
    expect(isRight(r)).toBe(true)
    if (isRight(r)) expect(r.right).toBe("ヤマダ タロウ")
  })

  it("normalize is idempotent", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 80 }), (s) => {
        const once = normalizeNameKana(s)
        return normalizeNameKana(once) === once
      }),
    )
  })

  it("rejects strings longer than 50 characters", () => {
    const long = "ア".repeat(51)
    expect(isLeft(parseNameKana(long))).toBe(true)
  })
})

describe("FreeText", () => {
  it("accepts the empty string", () => {
    const r = parseFreeText("")
    expect(isRight(r)).toBe(true)
  })

  it("accepts free text up to 500 chars", () => {
    const r = parseFreeText("a".repeat(500))
    expect(isRight(r)).toBe(true)
  })

  it("rejects free text longer than 500 chars", () => {
    const r = parseFreeText("a".repeat(501))
    expect(isLeft(r)).toBe(true)
  })

  it("strips control characters except \\n and \\t", () => {
    const r = parseFreeText("hello world\t\nbye")
    expect(isRight(r)).toBe(true)
    if (isRight(r)) expect(r.right).toBe("hello world\t\nbye")
  })

  it("normalize is idempotent", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (s) => {
        const once = normalizeFreeText(s)
        return normalizeFreeText(once) === once
      }),
    )
  })
})

describe("Minutes", () => {
  it.each([0, 1, 30, 60, 1440])("accepts %d", (n) => {
    expect(isRight(parseMinutes(n))).toBe(true)
  })

  it.each([-1, 1441, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects %p", (n) => {
    expect(isLeft(parseMinutes(n))).toBe(true)
  })
})

describe("HoldingDays", () => {
  it.each([0, 1, 7, 30])("accepts %d", (n) => {
    expect(isRight(parseHoldingDays(n))).toBe(true)
  })

  it.each([-1, 31, 0.5])("rejects %p", (n) => {
    expect(isLeft(parseHoldingDays(n))).toBe(true)
  })
})
