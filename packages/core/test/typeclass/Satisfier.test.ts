import * as fc from "fast-check"
import { describe, expect, it } from "vitest"
import * as Satisfier from "../../src/domain/typeclass/Satisfier.js"

const arbStringSet = (max = 10) =>
  fc
    .uniqueArray(fc.string({ minLength: 1, maxLength: 8 }), { maxLength: max })
    .map((xs) => new Set(xs))

describe("Satisfier", () => {
  describe("isSubsetOf", () => {
    it("reflexive: A ⊆ A (property)", () => {
      fc.assert(fc.property(arbStringSet(), (a) => Satisfier.isSubsetOf(a, a)))
    })

    it("∅ ⊆ A for every A (property)", () => {
      fc.assert(fc.property(arbStringSet(), (a) => Satisfier.isSubsetOf(new Set<string>(), a)))
    })

    it("transitive: A ⊆ B ∧ B ⊆ C ⇒ A ⊆ C (property)", () => {
      fc.assert(
        fc.property(arbStringSet(), arbStringSet(), arbStringSet(), (a, b, c) => {
          if (Satisfier.isSubsetOf(a, b) && Satisfier.isSubsetOf(b, c)) {
            return Satisfier.isSubsetOf(a, c)
          }
          return true
        }),
      )
    })

    it("monotone in superset: A ⊆ B ⇒ A ⊆ B ∪ {x} (property)", () => {
      fc.assert(
        fc.property(arbStringSet(), arbStringSet(), fc.string(), (a, b, extra) => {
          if (Satisfier.isSubsetOf(a, b)) {
            const augmented = new Set(b)
            augmented.add(extra)
            return Satisfier.isSubsetOf(a, augmented)
          }
          return true
        }),
      )
    })

    it("rejects sub ⊄ sup", () => {
      const sub = new Set(["a", "b", "c"])
      const sup = new Set(["a", "b"])
      expect(Satisfier.isSubsetOf(sub, sup)).toBe(false)
    })
  })

  describe("Satisfier.make", () => {
    it("wraps a predicate into a {satisfies} record", () => {
      const evenSatisfier = Satisfier.make<number, number>((c, n) => c % n === 0)
      expect(evenSatisfier.satisfies(8, 2)).toBe(true)
      expect(evenSatisfier.satisfies(8, 3)).toBe(false)
    })
  })
})
