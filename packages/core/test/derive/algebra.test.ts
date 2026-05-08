import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  always,
  and,
  fold,
  fromSchemaAst,
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

describe("fromSchemaAst", () => {
  it("an unchecked Schema folds to Always (no constraint)", () => {
    const p = fromSchemaAst<string>(Schema.String.ast)
    expect(fold(toSqlCheck("col"))(p)).toBeNull()
  })

  it("a single isPattern check folds to a single REGEXP clause", () => {
    const checked = Schema.String.check(Schema.isPattern(/^abc$/))
    const p = fromSchemaAst<string>(checked.ast)
    expect(fold(toSqlCheck("col"))(p)).toBe("col REGEXP '^abc$'")
  })

  it("a non-pattern check folds to Always (the predicate is opaque to the projection)", () => {
    // makeFilter has no `isPattern` annotation — the SQL projection
    // cannot lift it, so the lattice returns the neutral element.
    const checked = Schema.String.check(Schema.makeFilter((s: string) => s.length > 0))
    const p = fromSchemaAst<string>(checked.ast)
    expect(fold(toSqlCheck("col"))(p)).toBeNull()
  })

  it("multiple checks combine as conjunction", () => {
    const checked = Schema.String.check(Schema.isPattern(/^a/), Schema.isPattern(/z$/))
    const p = fromSchemaAst<string>(checked.ast)
    const out = fold(toSqlCheck("col"))(p)
    expect(out).toBe("(col REGEXP '^a' AND col REGEXP 'z$')")
  })
})

describe("toSqlCheck — conjunction edge cases", () => {
  it("And with a single child collapses to that child without parentheses", () => {
    const p: Predicate<string> = and(pattern(/^a$/))
    expect(fold(toSqlCheck("col"))(p)).toBe("col REGEXP '^a$'")
  })

  it("Or with a single child collapses to that child without parentheses", () => {
    const p: Predicate<string> = or(pattern(/^a$/))
    expect(fold(toSqlCheck("col"))(p)).toBe("col REGEXP '^a$'")
  })

  it("And with all-Always children collapses to null (no constraint)", () => {
    const p: Predicate<string> = and(always<string>(), always<string>())
    expect(fold(toSqlCheck("col"))(p)).toBeNull()
  })

  it("Not on Always (= no constraint) collapses to null", () => {
    expect(fold(toSqlCheck("col"))(not(always<string>()))).toBeNull()
  })
})
