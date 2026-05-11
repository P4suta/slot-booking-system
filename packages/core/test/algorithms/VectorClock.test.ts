import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { VectorClock } from "../../src/algorithms/VectorClock.js"

const siteArb = fc.constantFrom("a", "b", "c", "d")
const countArb = fc.integer({ min: 0, max: 50 })

const clockArb = fc
  .array(fc.tuple(siteArb, countArb), { maxLength: 6 })
  .map((pairs) => VectorClock.of(Object.fromEntries(pairs.map(([s, n]) => [s, n] as const))))

describe("VectorClock — lattice laws over merge", () => {
  it("idempotent: merge(a, a) = a", () => {
    fc.assert(
      fc.property(clockArb, (a) => {
        expect(VectorClock.equals(VectorClock.merge(a, a), a)).toBe(true)
      }),
    )
  })

  it("commutative: merge(a, b) = merge(b, a)", () => {
    fc.assert(
      fc.property(clockArb, clockArb, (a, b) => {
        expect(VectorClock.equals(VectorClock.merge(a, b), VectorClock.merge(b, a))).toBe(true)
      }),
    )
  })

  it("associative: merge(merge(a, b), c) = merge(a, merge(b, c))", () => {
    fc.assert(
      fc.property(clockArb, clockArb, clockArb, (a, b, c) => {
        expect(
          VectorClock.equals(
            VectorClock.merge(VectorClock.merge(a, b), c),
            VectorClock.merge(a, VectorClock.merge(b, c)),
          ),
        ).toBe(true)
      }),
    )
  })
})

describe("VectorClock — happens-before partial order", () => {
  it("tick produces a strict successor", () => {
    fc.assert(
      fc.property(clockArb, siteArb, (clock, site) => {
        const next = VectorClock.tick(clock, site)
        expect(VectorClock.happensBefore(clock, next)).toBe(true)
        expect(VectorClock.happensBefore(next, clock)).toBe(false)
      }),
    )
  })

  it("happensBefore implies leq", () => {
    fc.assert(
      fc.property(clockArb, clockArb, (a, b) => {
        if (VectorClock.happensBefore(a, b)) {
          expect(VectorClock.leq(a, b)).toBe(true)
        }
      }),
    )
  })

  it("concurrent ↔ incomparable", () => {
    fc.assert(
      fc.property(clockArb, clockArb, (a, b) => {
        const conc = VectorClock.concurrent(a, b)
        const incomparable = !VectorClock.leq(a, b) && !VectorClock.leq(b, a)
        expect(conc).toBe(incomparable)
      }),
    )
  })

  it("empty clock is least element", () => {
    fc.assert(
      fc.property(clockArb, (a) => {
        expect(VectorClock.leq(VectorClock.empty(), a)).toBe(true)
      }),
    )
  })

  it("of(record) constructs a clock with the supplied counters", () => {
    const clock = VectorClock.of({ a: 3, b: 5 })
    expect(VectorClock.get(clock, "a")).toBe(3)
    expect(VectorClock.get(clock, "b")).toBe(5)
    expect(VectorClock.get(clock, "absent")).toBe(0)
  })

  it("equals returns false on size mismatch / counter mismatch", () => {
    expect(VectorClock.equals(VectorClock.empty(), VectorClock.of({ a: 1 }))).toBe(false)
    expect(VectorClock.equals(VectorClock.of({ a: 1 }), VectorClock.of({ a: 2 }))).toBe(false)
    expect(VectorClock.equals(VectorClock.of({ a: 1 }), VectorClock.of({ b: 1 }))).toBe(false)
  })
})
