import { describe, expect, it } from "vitest"
import { timingSafeEqual } from "../../../src/server/security/timingSafeEqual.js"

/**
 * Equivalence tests for the constant-time comparator. The timing
 * guarantee itself is not directly observable from the test
 * harness (microbenchmarks are unreliable on shared CI runners);
 * the asserts below pin the *result* against `===` so a future
 * implementation regression is caught structurally.
 */

const fixtures: readonly string[] = [
  "",
  "a",
  "abc",
  "abcdef0123456789",
  "🍱-emoji",
  "あいうえお",
  "dev-placeholder-replace-in-prod-32-bytes-hex-0123456789abcdef",
  "Mixed_Case-12345",
]

describe("timingSafeEqual", () => {
  it("equal inputs return true", () => {
    for (const s of fixtures) {
      expect(timingSafeEqual(s, s)).toBe(true)
    }
  })

  it("byte-length mismatch returns false", () => {
    for (const a of fixtures) {
      for (const b of fixtures) {
        const aLen = new TextEncoder().encode(a).byteLength
        const bLen = new TextEncoder().encode(b).byteLength
        if (aLen !== bLen) {
          expect(timingSafeEqual(a, b)).toBe(false)
        }
      }
    }
  })

  it("single-byte difference at any position returns false", () => {
    const base = "abcdefghijklmnop"
    for (let i = 0; i < base.length; i += 1) {
      const ch = base.charCodeAt(i)
      const mutated = base.slice(0, i) + String.fromCharCode((ch + 1) & 0x7f) + base.slice(i + 1)
      expect(timingSafeEqual(base, mutated)).toBe(false)
    }
  })

  it("the empty pair compares equal", () => {
    expect(timingSafeEqual("", "")).toBe(true)
  })

  it("non-ASCII strings compare via UTF-8 byte length", () => {
    // 'あ' is 3 bytes UTF-8; 'abc' is 3. Same encoded byte length,
    // different bytes — the loop catches the difference.
    expect(timingSafeEqual("あ", "abc")).toBe(false)
    expect(timingSafeEqual("あ", "あ")).toBe(true)
    // Length-mismatch path: 'あ' (3 bytes) vs 'aa' (2 bytes).
    expect(timingSafeEqual("あ", "aa")).toBe(false)
  })

  it("agrees with === across every cross-pair in the fixture matrix", () => {
    for (const a of fixtures) {
      for (const b of fixtures) {
        expect(timingSafeEqual(a, b)).toBe(a === b)
      }
    }
  })
})
