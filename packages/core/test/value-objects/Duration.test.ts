import { Temporal } from "@js-temporal/polyfill"
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { Duration } from "../../src/domain/value-objects/Duration.js"

const graceMs = fc.integer({ min: 0, max: 365 * 24 * 60 * 60 * 1000 })
const grace = graceMs.map((ms) => Duration.ms("Grace", ms))

describe("Duration — constructors", () => {
  it("ms is identity on non-negative integers", () => {
    fc.assert(
      fc.property(graceMs, (ms) => {
        expect(Duration.toMillis(Duration.ms("Grace", ms))).toBe(ms)
      }),
    )
  })

  it("seconds and minutes round-trip via toMillis", () => {
    expect(Duration.toMillis(Duration.seconds("Grace", 30))).toBe(30_000)
    expect(Duration.toMillis(Duration.minutes("Grace", 10))).toBe(600_000)
    expect(Duration.toMillis(Duration.minutes("Grace", 0))).toBe(0)
  })

  it("rejects negative, NaN, non-integer ms as Defect", () => {
    expect(() => Duration.ms("Grace", -1)).toThrow(RangeError)
    expect(() => Duration.ms("Grace", Number.NaN)).toThrow(RangeError)
    expect(() => Duration.ms("Grace", 1.5)).toThrow(RangeError)
    expect(() => Duration.ms("Grace", Number.POSITIVE_INFINITY)).toThrow(RangeError)
  })

  it("fromTemporal round-trips via toTemporal (modulo ms granularity)", () => {
    const d = Duration.fromTemporal("Grace", Temporal.Duration.from({ minutes: 7, seconds: 3 }))
    expect(Duration.toMillis(d)).toBe(7 * 60_000 + 3_000)
    expect(Duration.toTemporal(d).total({ unit: "milliseconds" })).toBe(Duration.toMillis(d))
  })
})

describe("Duration — commutative monoid laws under add/zero", () => {
  const zero = Duration.zero("Grace")

  it("left identity: zero ⊕ d ≡ d", () => {
    fc.assert(
      fc.property(grace, (d) => {
        expect(Duration.equals(Duration.add(zero, d), d)).toBe(true)
      }),
    )
  })

  it("right identity: d ⊕ zero ≡ d", () => {
    fc.assert(
      fc.property(grace, (d) => {
        expect(Duration.equals(Duration.add(d, zero), d)).toBe(true)
      }),
    )
  })

  it("associativity: (a ⊕ b) ⊕ c ≡ a ⊕ (b ⊕ c)", () => {
    fc.assert(
      fc.property(grace, grace, grace, (a, b, c) => {
        expect(
          Duration.equals(Duration.add(Duration.add(a, b), c), Duration.add(a, Duration.add(b, c))),
        ).toBe(true)
      }),
    )
  })

  it("commutativity: a ⊕ b ≡ b ⊕ a", () => {
    fc.assert(
      fc.property(grace, grace, (a, b) => {
        expect(Duration.equals(Duration.add(a, b), Duration.add(b, a))).toBe(true)
      }),
    )
  })
})

describe("Duration — total order under compare", () => {
  it("compare is antisymmetric: sgn(cmp(a,b)) = -sgn(cmp(b,a))", () => {
    fc.assert(
      fc.property(grace, grace, (a, b) => {
        const forward = Duration.compare(a, b)
        const reverse = Duration.compare(b, a)
        // 0 maps to 0; ±1 map to ∓1. Avoid the `-0` vs `0` Object.is pitfall.
        expect(forward === 0 ? reverse : -forward).toBe(reverse)
      }),
    )
  })

  it("compare is transitive: a≤b ∧ b≤c ⇒ a≤c", () => {
    fc.assert(
      fc.property(grace, grace, grace, (a, b, c) => {
        if (Duration.compare(a, b) <= 0 && Duration.compare(b, c) <= 0) {
          expect(Duration.compare(a, c)).toBeLessThanOrEqual(0)
        }
      }),
    )
  })

  it("equals iff compare returns 0", () => {
    fc.assert(
      fc.property(grace, grace, (a, b) => {
        expect(Duration.equals(a, b)).toBe(Duration.compare(a, b) === 0)
      }),
    )
  })

  it("compare yields 0 on identical magnitudes", () => {
    fc.assert(
      fc.property(graceMs, (ms) => {
        const a = Duration.ms("Grace", ms)
        const b = Duration.ms("Grace", ms)
        expect(Duration.compare(a, b)).toBe(0)
        expect(Duration.equals(a, b)).toBe(true)
      }),
    )
  })
})

describe("Duration — addToEpoch", () => {
  it("matches manual epoch + ms", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0 }), grace, (epoch, d) => {
        expect(Duration.addToEpoch(epoch, d)).toBe(epoch + Duration.toMillis(d))
      }),
    )
  })
})
