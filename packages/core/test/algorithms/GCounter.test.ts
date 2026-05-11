import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { GCounter } from "../../src/algorithms/GCounter.js"

const siteArb = fc.constantFrom("a", "b", "c")
const incArb = fc.tuple(siteArb, fc.integer({ min: 0, max: 10 }))

const counterArb = fc
  .array(incArb, { maxLength: 12 })
  .map((ops) => ops.reduce((c, [site, n]) => GCounter.increment(c, site, n), GCounter.empty()))

describe("GCounter — semilattice laws", () => {
  it("idempotent: merge(a, a) = a", () => {
    fc.assert(
      fc.property(counterArb, (a) => {
        expect(GCounter.equals(GCounter.merge(a, a), a)).toBe(true)
      }),
    )
  })

  it("commutative: merge(a, b) = merge(b, a)", () => {
    fc.assert(
      fc.property(counterArb, counterArb, (a, b) => {
        expect(GCounter.equals(GCounter.merge(a, b), GCounter.merge(b, a))).toBe(true)
      }),
    )
  })

  it("associative: merge(merge(a, b), c) = merge(a, merge(b, c))", () => {
    fc.assert(
      fc.property(counterArb, counterArb, counterArb, (a, b, c) => {
        expect(
          GCounter.equals(
            GCounter.merge(GCounter.merge(a, b), c),
            GCounter.merge(a, GCounter.merge(b, c)),
          ),
        ).toBe(true)
      }),
    )
  })

  it("monotone: value(merge(a, b)) ≥ max(value(a), value(b))", () => {
    fc.assert(
      fc.property(counterArb, counterArb, (a, b) => {
        const merged = GCounter.merge(a, b)
        expect(GCounter.value(merged)).toBeGreaterThanOrEqual(
          Math.max(GCounter.value(a), GCounter.value(b)),
        )
      }),
    )
  })
})

describe("GCounter — observed value", () => {
  it("empty counter is zero", () => {
    expect(GCounter.value(GCounter.empty())).toBe(0)
  })

  it("local increments accumulate per site", () => {
    const c = [3, 2, 5].reduce((acc, n) => GCounter.increment(acc, "a", n), GCounter.empty())
    expect(GCounter.value(c)).toBe(10)
  })

  it("rejects negative or non-integer increments", () => {
    expect(() => GCounter.increment(GCounter.empty(), "a", -1)).toThrow(RangeError)
    expect(() => GCounter.increment(GCounter.empty(), "a", 1.5)).toThrow(RangeError)
  })

  it("equals returns true on identical counters, false on divergent ones", () => {
    const a = GCounter.increment(GCounter.empty(), "a", 3)
    const b = GCounter.increment(GCounter.empty(), "a", 3)
    expect(GCounter.equals(a, b)).toBe(true)
    const c = GCounter.increment(GCounter.empty(), "a", 4)
    expect(GCounter.equals(a, c)).toBe(false)
    const d = GCounter.increment(GCounter.empty(), "b", 3)
    expect(GCounter.equals(a, d)).toBe(false)
    expect(GCounter.equals(GCounter.empty(), a)).toBe(false)
  })
})
