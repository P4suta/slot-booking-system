import { describe, expect, it } from "vitest"
import { containsHiragana, toKatakana, validateNameKana } from "../../src/lib/kana.js"

/**
 * Kana helpers — invariants that the issue / recover forms rely on.
 * Most critical: `validateNameKana` MUST mirror the server's
 * `NameKanaSchema` so the inline error correctly predicts which
 * submissions the server will reject as `InvalidNameKana`.
 */

describe("toKatakana", () => {
  it("converts hiragana to katakana", () => {
    expect(toKatakana("さとう")).toBe("サトウ")
    expect(toKatakana("やまだたろう")).toBe("ヤマダタロウ")
  })

  it("leaves katakana unchanged (idempotent)", () => {
    expect(toKatakana("サトウ")).toBe("サトウ")
    expect(toKatakana(toKatakana("さとう"))).toBe("サトウ")
  })

  it("leaves non-kana characters unchanged", () => {
    expect(toKatakana("yamada")).toBe("yamada")
    expect(toKatakana("山田")).toBe("山田")
    expect(toKatakana("サ 1 さ")).toBe("サ 1 サ")
  })

  it("preserves the prolonged-sound mark and half-width katakana", () => {
    expect(toKatakana("ラーメン")).toBe("ラーメン")
    expect(toKatakana("ﾔﾏﾀﾞ")).toBe("ﾔﾏﾀﾞ")
  })
})

describe("containsHiragana", () => {
  it("returns true on any hiragana code point", () => {
    expect(containsHiragana("さ")).toBe(true)
    expect(containsHiragana("サ さ")).toBe(true)
  })

  it("returns false on pure katakana / ascii / kanji", () => {
    expect(containsHiragana("")).toBe(false)
    expect(containsHiragana("サトウ")).toBe(false)
    expect(containsHiragana("yamada")).toBe(false)
    expect(containsHiragana("山田")).toBe(false)
  })
})

describe("validateNameKana", () => {
  it("classifies empty as 'empty'", () => {
    expect(validateNameKana("")).toBe("empty")
  })

  it("accepts pure katakana", () => {
    expect(validateNameKana("ヤマダタロウ")).toBe("ok")
    expect(validateNameKana("サトウ")).toBe("ok")
  })

  it("accepts pure hiragana (autoconverted on submit)", () => {
    expect(validateNameKana("やまだたろう")).toBe("ok")
  })

  it("accepts katakana with a single ASCII space between segments", () => {
    expect(validateNameKana("ヤマダ タロウ")).toBe("ok")
    expect(validateNameKana("やまだ たろう")).toBe("ok")
  })

  it("accepts the prolonged-sound mark and half-width katakana", () => {
    expect(validateNameKana("ラーメン")).toBe("ok")
    expect(validateNameKana("ﾔﾏﾀﾞ")).toBe("ok")
  })

  it("rejects kanji", () => {
    expect(validateNameKana("山田")).toBe("invalid_chars")
    expect(validateNameKana("ヤマダ 太郎")).toBe("invalid_chars")
  })

  it("rejects ASCII letters", () => {
    expect(validateNameKana("yamada")).toBe("invalid_chars")
    expect(validateNameKana("Yamada Taro")).toBe("invalid_chars")
  })

  it("rejects digits and symbols", () => {
    expect(validateNameKana("ヤマダ123")).toBe("invalid_chars")
    expect(validateNameKana("ヤマダ!")).toBe("invalid_chars")
    expect(validateNameKana("ヤマダ@example.com")).toBe("invalid_chars")
  })

  it("rejects multi-space and leading / trailing space (regex enforces single ASCII separator)", () => {
    expect(validateNameKana(" ヤマダ")).toBe("invalid_chars")
    expect(validateNameKana("ヤマダ ")).toBe("invalid_chars")
    expect(validateNameKana("ヤマダ  タロウ")).toBe("invalid_chars")
  })

  it("rejects over-length strings (> 50 chars)", () => {
    const long = "ア".repeat(51)
    expect(validateNameKana(long)).toBe("too_long")
  })

  it("accepts exactly 50 chars", () => {
    const max = "ア".repeat(50)
    expect(validateNameKana(max)).toBe("ok")
  })

  it("rejects whitespace-only input", () => {
    expect(validateNameKana("   ")).toBe("invalid_chars")
  })
})
