import * as fc from "fast-check"
import { describe, expect, it } from "vitest"
import * as B from "../../src/domain/slot/Bitmap.js"

const bitsToBitmap = (bits: readonly boolean[]): B.Bitmap =>
  bits.reduce((acc, b, i) => (b ? B.setRange(acc, i, i + 1) : acc), B.empty(bits.length))

const arbBitmapOfLength = (len: number) =>
  fc.array(fc.boolean(), { minLength: len, maxLength: len }).map(bitsToBitmap)

const arbBitmap = (maxLen = 200) =>
  fc.integer({ min: 0, max: maxLen }).chain((len) => arbBitmapOfLength(len))

const arbSameLengthPair = (maxLen = 200) =>
  fc
    .integer({ min: 0, max: maxLen })
    .chain((len) => fc.tuple(arbBitmapOfLength(len), arbBitmapOfLength(len)))

describe("Bitmap", () => {
  describe("construction", () => {
    it("empty(0) has zero length and zero popcount", () => {
      const bm = B.empty(0)
      expect(bm.length).toBe(0)
      expect(B.popcount(bm)).toBe(0)
    })

    it("empty(n) has popcount 0 and isSet false everywhere", () => {
      const bm = B.empty(100)
      expect(B.popcount(bm)).toBe(0)
      for (let i = 0; i < 100; i++) expect(B.isSet(bm, i)).toBe(false)
    })

    it("full(n) has popcount n and isSet true everywhere", () => {
      const bm = B.full(100)
      expect(B.popcount(bm)).toBe(100)
      for (let i = 0; i < 100; i++) expect(B.isSet(bm, i)).toBe(true)
    })

    it("full(n) only sets bits within [0,n) — out-of-range queries are false", () => {
      const bm = B.full(33)
      expect(B.isSet(bm, 32)).toBe(true)
      expect(B.isSet(bm, 33)).toBe(false)
      expect(B.isSet(bm, -1)).toBe(false)
    })

    it("negative length is clamped to 0", () => {
      expect(B.empty(-5).length).toBe(0)
      expect(B.full(-1).length).toBe(0)
    })
  })

  describe("setRange / clearRange", () => {
    it("set then clear restores empty", () => {
      const bm = B.clearRange(B.setRange(B.empty(100), 10, 50), 10, 50)
      expect(B.popcount(bm)).toBe(0)
    })

    it("setRange is idempotent", () => {
      const a = B.setRange(B.empty(100), 5, 70)
      const b = B.setRange(a, 5, 70)
      expect(B.equals(a, b)).toBe(true)
    })

    it("setRange across word boundaries", () => {
      const bm = B.setRange(B.empty(100), 30, 65)
      expect(B.popcount(bm)).toBe(35)
      for (let i = 30; i < 65; i++) expect(B.isSet(bm, i)).toBe(true)
      expect(B.isSet(bm, 29)).toBe(false)
      expect(B.isSet(bm, 65)).toBe(false)
    })

    it("setRange clamps out-of-range start/end", () => {
      const bm = B.setRange(B.empty(50), -10, 200)
      expect(B.popcount(bm)).toBe(50)
    })

    it("inverted range is a no-op", () => {
      const bm = B.setRange(B.empty(50), 30, 20)
      expect(B.popcount(bm)).toBe(0)
    })
  })

  describe("logical ops", () => {
    it("a AND a = a", () => {
      fc.assert(fc.property(arbBitmap(), (a) => B.equals(B.and(a, a), a)))
    })

    it("a OR a = a", () => {
      fc.assert(fc.property(arbBitmap(), (a) => B.equals(B.or(a, a), a)))
    })

    it("NOT NOT a = a", () => {
      fc.assert(fc.property(arbBitmap(), (a) => B.equals(B.not(B.not(a)), a)))
    })

    it("De Morgan: NOT (a OR b) = (NOT a) AND (NOT b) when lengths match", () => {
      fc.assert(
        fc.property(arbSameLengthPair(), ([a, b]) =>
          B.equals(B.not(B.or(a, b)), B.and(B.not(a), B.not(b))),
        ),
      )
    })

    it("popcount(a OR b) ≥ max(popcount(a), popcount(b))", () => {
      fc.assert(
        fc.property(arbBitmap(100), arbBitmap(100), (a, b) => {
          const lhs = B.popcount(B.or(a, b))
          const rhs = Math.max(B.popcount(a), B.popcount(b))
          return lhs >= rhs
        }),
      )
    })
  })

  describe("shiftDown", () => {
    it("shift by 0 is identity", () => {
      fc.assert(fc.property(arbBitmap(), (a) => B.equals(B.shiftDown(a, 0), a)))
    })

    it("shifting by length yields all-zeros", () => {
      const a = B.full(100)
      expect(B.popcount(B.shiftDown(a, 100))).toBe(0)
    })

    it("bit b of shiftDown(a, n) equals bit b+n of a", () => {
      fc.assert(
        fc.property(arbBitmap(150), fc.integer({ min: 1, max: 100 }), (a, n) => {
          const shifted = B.shiftDown(a, n)
          for (let b = 0; b < a.length; b++) {
            const expected = b + n < a.length && B.isSet(a, b + n)
            if (B.isSet(shifted, b) !== expected) return false
          }
          return true
        }),
      )
    })

    it("shifting across word boundaries preserves bit count of unshifted prefix", () => {
      const a = B.setRange(B.empty(100), 35, 70) // 35 bits in [35..70)
      const shifted = B.shiftDown(a, 5)
      // bits at [30..65) in shifted
      expect(B.popcount(shifted)).toBe(35)
      for (let i = 30; i < 65; i++) expect(B.isSet(shifted, i)).toBe(true)
    })
  })

  describe("findRunsOfLength", () => {
    it("returns empty for runLength > length", () => {
      expect(B.findRunsOfLength(B.full(10), 11)).toEqual([])
    })

    it("returns every offset for runLength = 0", () => {
      expect(B.findRunsOfLength(B.empty(5), 0)).toEqual([0, 1, 2, 3, 4])
    })

    it("on full bitmap returns every valid starting offset", () => {
      expect(B.findRunsOfLength(B.full(10), 3)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    })

    it("on empty bitmap returns nothing for any positive runLength", () => {
      expect(B.findRunsOfLength(B.empty(10), 1)).toEqual([])
    })

    it("finds expected runs in a known shape", () => {
      // 000111110001110 — runs of 1 are length 5 at idx 3 and length 3 at idx 11
      const bm = B.fromBinaryString("000111110001110")
      expect(B.findRunsOfLength(bm, 5)).toEqual([3])
      expect(B.findRunsOfLength(bm, 3)).toEqual([3, 4, 5, 11])
      expect(B.findRunsOfLength(bm, 6)).toEqual([])
    })

    it("property: every offset returned admits runLength consecutive set bits", () => {
      fc.assert(
        fc.property(arbBitmap(120), fc.integer({ min: 1, max: 60 }), (bm, runLength) => {
          for (const offset of B.findRunsOfLength(bm, runLength)) {
            for (let i = 0; i < runLength; i++) {
              if (!B.isSet(bm, offset + i)) return false
            }
          }
          return true
        }),
        { numRuns: 500 },
      )
    })

    it("property: monotonic — clearing more bits cannot increase the number of runs", () => {
      fc.assert(
        fc.property(
          arbBitmap(80),
          fc.integer({ min: 0, max: 80 }),
          fc.integer({ min: 0, max: 80 }),
          fc.integer({ min: 1, max: 30 }),
          (bm, a, b, runLength) => {
            const lo = Math.min(a, b)
            const hi = Math.max(a, b)
            const cleared = B.clearRange(bm, lo, hi)
            return (
              B.findRunsOfLength(cleared, runLength).length <=
              B.findRunsOfLength(bm, runLength).length
            )
          },
        ),
        { numRuns: 500 },
      )
    })
  })

  describe("toBinaryString / fromBinaryString", () => {
    it("round-trips", () => {
      fc.assert(
        fc.property(
          fc.stringMatching(/^[01]{0,200}$/),
          (s) => B.toBinaryString(B.fromBinaryString(s)) === s,
        ),
      )
    })
  })
})
