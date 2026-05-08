import { describe, expect, it } from "vitest"
import {
  always,
  and,
  fold,
  not,
  or,
  type Predicate,
  type PredicateAlgebra,
  pattern,
  toSqlCheck,
} from "../../src/derive/algebra.js"

const truthy: PredicateAlgebra<string, boolean> = {
  Pattern: () => true,
  And: (rs) => rs.every(Boolean),
  Or: (rs) => rs.some(Boolean),
  Not: (r) => !r,
  Always: () => true,
}

describe("Predicate algebra (ADR-0042)", () => {
  it("toSqlCheck on a single Pattern emits one REGEXP clause", () => {
    const p = pattern<string>(/^abc$/)
    expect(fold(toSqlCheck("col"))(p)).toBe("col REGEXP '^abc$'")
  })

  it("toSqlCheck on And combines present children with AND", () => {
    const p: Predicate<string> = and(pattern(/^a$/), pattern(/^b$/))
    expect(fold(toSqlCheck("col"))(p)).toBe("(col REGEXP '^a$' AND col REGEXP '^b$')")
  })

  it("toSqlCheck on Or combines present children with OR", () => {
    const p: Predicate<string> = or(pattern(/^a$/), pattern(/^b$/))
    expect(fold(toSqlCheck("col"))(p)).toBe("(col REGEXP '^a$' OR col REGEXP '^b$')")
  })

  it("toSqlCheck on Not negates a present child", () => {
    expect(fold(toSqlCheck("col"))(not(pattern(/^x$/)))).toBe("NOT (col REGEXP '^x$')")
  })

  it("toSqlCheck on Always returns null (no constraint)", () => {
    expect(fold(toSqlCheck("col"))(always<string>())).toBeNull()
  })

  it("Or is OR's neutral element across algebras (truthy returns false on empty Or)", () => {
    expect(fold(truthy)(and<string>())).toBe(true)
    expect(fold(truthy)(or<string>())).toBe(false)
    expect(fold(truthy)(not(always<string>()))).toBe(false)
  })

  it("escapes single quotes inside regex source", () => {
    const p = pattern<string>(/^O'Brien$/)
    expect(fold(toSqlCheck("col"))(p)).toBe("col REGEXP '^O''Brien$'")
  })
})
