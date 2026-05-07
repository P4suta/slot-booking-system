import { Result, Schema } from "effect"
import * as fc from "fast-check"
import { describe, expect, it } from "vitest"
import { isMinutes, parseMinutes } from "../../src/domain/value-objects/Duration.js"
import {
  FreeTextSchema,
  normalizeFreeText,
  parseFreeText,
} from "../../src/domain/value-objects/FreeText.js"
import { isHoldingDays, parseHoldingDays } from "../../src/domain/value-objects/HoldingDays.js"
import {
  NameKanaSchema,
  normalizeNameKana,
  parseNameKana,
} from "../../src/domain/value-objects/NameKana.js"

const isLeft = Result.isFailure
const isRight = Result.isSuccess

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
    if (isRight(r)) expect(r.success).toBe("ヤマダ タロウ")
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

  it("encodes a branded value back to the (already-normalised) string", () => {
    const r = parseNameKana("ヤマダ タロウ")
    expect(isRight(r)).toBe(true)
    if (isRight(r)) {
      expect(Schema.encodeSync(NameKanaSchema)(r.success)).toBe("ヤマダ タロウ")
    }
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

  it("strips C0/DEL/C1 controls and keeps \\t and \\n", () => {
    // BEL (0x07) → range 1, VT (0x0B), FF (0x0C), ESC (0x1B) → range 4,
    // DEL (0x7F) and NEL (0x85, C1) → range 5. Tab (0x09) and LF (0x0A)
    // are deliberately *not* in the deny list and must survive.
    const raw = "abcdefg\thello\nworld"
    const r = parseFreeText(raw)
    expect(isRight(r)).toBe(true)
    if (isRight(r)) expect(r.success).toBe("abcdefg\thello\nworld")
  })

  it("counts surrogate pairs as one code point (multi-byte safety)", () => {
    expect(isRight(parseFreeText("💩".repeat(500)))).toBe(true)
    expect(isLeft(parseFreeText("💩".repeat(501)))).toBe(true)
  })

  it("normalize is idempotent", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (s) => {
        const once = normalizeFreeText(s)
        return normalizeFreeText(once) === once
      }),
    )
  })

  it("encodes a branded value back to the (already-normalised) string", () => {
    const r = parseFreeText("hello world")
    expect(isRight(r)).toBe(true)
    if (isRight(r)) {
      expect(Schema.encodeSync(FreeTextSchema)(r.success)).toBe("hello world")
    }
  })
})

describe("Minutes", () => {
  it.each([0, 1, 30, 60, 1440])("accepts %d", (n) => {
    expect(isRight(parseMinutes(n))).toBe(true)
  })

  it.each([-1, 1441, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects %p", (n) => {
    expect(isLeft(parseMinutes(n))).toBe(true)
  })

  it("isMinutes guard mirrors parseMinutes", () => {
    expect(isMinutes(0)).toBe(true)
    expect(isMinutes(1440)).toBe(true)
    expect(isMinutes(-1)).toBe(false)
    expect(isMinutes(1.5)).toBe(false)
  })
})

describe("HoldingDays", () => {
  it.each([0, 1, 7, 30])("accepts %d", (n) => {
    expect(isRight(parseHoldingDays(n))).toBe(true)
  })

  it.each([-1, 31, 0.5])("rejects %p", (n) => {
    expect(isLeft(parseHoldingDays(n))).toBe(true)
  })

  it("isHoldingDays guard mirrors parseHoldingDays", () => {
    expect(isHoldingDays(0)).toBe(true)
    expect(isHoldingDays(30)).toBe(true)
    expect(isHoldingDays(31)).toBe(false)
    expect(isHoldingDays(0.5)).toBe(false)
  })
})
