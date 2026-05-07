import * as fc from "fast-check"
import { describe, expect, it } from "vitest"
import type { StaffScope } from "../../../src/domain/auth/Capability.js"
import * as ScopeSet from "../../../src/domain/auth/ScopeSet.js"

const arbScope: fc.Arbitrary<StaffScope> = fc.constantFrom(...ScopeSet.ALL_SCOPES)
const arbScopeArray = fc.array(arbScope, { maxLength: 10 })
const arbScopeSet = arbScopeArray.map(ScopeSet.fromScopes)

describe("ScopeSet", () => {
  describe("constructors", () => {
    it("empty has no scopes", () => {
      const e = ScopeSet.empty()
      for (const s of ScopeSet.ALL_SCOPES) expect(ScopeSet.hasScope(e, s)).toBe(false)
    })

    it("full has every scope", () => {
      const f = ScopeSet.full()
      for (const s of ScopeSet.ALL_SCOPES) expect(ScopeSet.hasScope(f, s)).toBe(true)
    })

    it("singleton(s) contains exactly s", () => {
      for (const s of ScopeSet.ALL_SCOPES) {
        const set = ScopeSet.singleton(s)
        for (const t of ScopeSet.ALL_SCOPES) {
          expect(ScopeSet.hasScope(set, t)).toBe(s === t)
        }
      }
    })
  })

  describe("fromScopes / toScopes round-trip", () => {
    it("toScopes(fromScopes(arr)) is arr de-duplicated and canonically ordered (property)", () => {
      fc.assert(
        fc.property(arbScopeArray, (arr) => {
          const set = ScopeSet.fromScopes(arr)
          const out = ScopeSet.toScopes(set)
          const expected = ScopeSet.ALL_SCOPES.filter((s) => arr.includes(s))
          return JSON.stringify(out) === JSON.stringify(expected)
        }),
      )
    })

    it("fromScopes(toScopes(set)) === set (property)", () => {
      fc.assert(
        fc.property(arbScopeSet, (set) => {
          const round = ScopeSet.fromScopes(ScopeSet.toScopes(set))
          return ScopeSet.equals(round, set)
        }),
      )
    })
  })

  describe("merge — bounded join-semilattice laws", () => {
    it("idempotent: a ∪ a ≡ a (property)", () => {
      fc.assert(fc.property(arbScopeSet, (a) => ScopeSet.equals(ScopeSet.merge(a, a), a)))
    })

    it("commutative: a ∪ b ≡ b ∪ a (property)", () => {
      fc.assert(
        fc.property(arbScopeSet, arbScopeSet, (a, b) =>
          ScopeSet.equals(ScopeSet.merge(a, b), ScopeSet.merge(b, a)),
        ),
      )
    })

    it("associative: (a ∪ b) ∪ c ≡ a ∪ (b ∪ c) (property)", () => {
      fc.assert(
        fc.property(arbScopeSet, arbScopeSet, arbScopeSet, (a, b, c) =>
          ScopeSet.equals(
            ScopeSet.merge(ScopeSet.merge(a, b), c),
            ScopeSet.merge(a, ScopeSet.merge(b, c)),
          ),
        ),
      )
    })

    it("⊥ identity: ∅ ∪ a ≡ a (property)", () => {
      fc.assert(
        fc.property(arbScopeSet, (a) => ScopeSet.equals(ScopeSet.merge(ScopeSet.empty(), a), a)),
      )
    })

    it("⊤ absorbing: ⊤ ∪ a ≡ ⊤ (property)", () => {
      fc.assert(
        fc.property(arbScopeSet, (a) =>
          ScopeSet.equals(ScopeSet.merge(ScopeSet.full(), a), ScopeSet.full()),
        ),
      )
    })

    it("monotonic in containment: hasScope(a, s) ⇒ hasScope(merge(a, b), s) (property)", () => {
      fc.assert(
        fc.property(arbScopeSet, arbScopeSet, arbScope, (a, b, s) => {
          if (!ScopeSet.hasScope(a, s)) return true
          return ScopeSet.hasScope(ScopeSet.merge(a, b), s)
        }),
      )
    })
  })
})
