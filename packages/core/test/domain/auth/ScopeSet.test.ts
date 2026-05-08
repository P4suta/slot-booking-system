import { describe, expect, it } from "vitest"
import {
  ALL_SCOPES,
  empty,
  equals,
  fromScopes,
  full,
  hasScope,
  merge,
  type StaffScope,
  singleton,
  toScopes,
} from "../../../src/domain/auth/ScopeSet.js"

describe("ALL_SCOPES", () => {
  it("is the queue pivot's single scope universe", () => {
    expect(ALL_SCOPES).toEqual(["operate_queue"])
  })
})

describe("empty / full / singleton / fromScopes", () => {
  it("empty has no scopes", () => {
    expect(toScopes(empty())).toEqual([])
  })

  it("full has every scope", () => {
    expect(toScopes(full())).toEqual(ALL_SCOPES)
  })

  it("singleton has exactly the requested scope", () => {
    const s = singleton("operate_queue")
    expect(toScopes(s)).toEqual(["operate_queue"])
  })

  it("fromScopes round-trips through toScopes", () => {
    expect(toScopes(fromScopes(["operate_queue"]))).toEqual(["operate_queue"])
  })

  it("fromScopes deduplicates a repeated scope", () => {
    const s = fromScopes(["operate_queue", "operate_queue"] as readonly StaffScope[])
    expect(toScopes(s)).toEqual(["operate_queue"])
  })
})

describe("hasScope", () => {
  it("returns true for a granted scope", () => {
    expect(hasScope(full(), "operate_queue")).toBe(true)
  })

  it("returns false for a missing scope", () => {
    expect(hasScope(empty(), "operate_queue")).toBe(false)
  })
})

describe("merge — bounded join-semilattice laws", () => {
  it("⊥ is the identity (⊥ ∪ x = x)", () => {
    const x = singleton("operate_queue")
    expect(equals(merge(empty(), x), x)).toBe(true)
    expect(equals(merge(x, empty()), x)).toBe(true)
  })

  it("idempotent (x ∪ x = x)", () => {
    const x = singleton("operate_queue")
    expect(equals(merge(x, x), x)).toBe(true)
  })

  it("commutative (a ∪ b = b ∪ a)", () => {
    const a = empty()
    const b = singleton("operate_queue")
    expect(equals(merge(a, b), merge(b, a))).toBe(true)
  })

  it("associative ((a ∪ b) ∪ c = a ∪ (b ∪ c))", () => {
    const a = empty()
    const b = singleton("operate_queue")
    const c = full()
    expect(equals(merge(merge(a, b), c), merge(a, merge(b, c)))).toBe(true)
  })
})

describe("equals", () => {
  it("two empties are equal", () => {
    expect(equals(empty(), empty())).toBe(true)
  })

  it("empty and full are not equal", () => {
    expect(equals(empty(), full())).toBe(false)
  })
})
