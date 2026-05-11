import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { ORSet } from "../../src/algorithms/ORSet.js"

type Op =
  | { readonly kind: "add"; readonly value: string; readonly tag: string }
  | { readonly kind: "remove"; readonly value: string }

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc
    .tuple(fc.constantFrom("x", "y", "z"), fc.uuid())
    .map(([value, tag]): Op => ({ kind: "add", value, tag })),
  fc.constantFrom("x", "y", "z").map((value): Op => ({ kind: "remove", value })),
)

const applyOps = (start: ORSet<string>, ops: readonly Op[]): ORSet<string> =>
  ops.reduce<ORSet<string>>(
    (acc, op) =>
      op.kind === "add" ? ORSet.add(acc, op.value, op.tag) : ORSet.remove(acc, op.value),
    start,
  )

const setArb = fc.array(opArb, { maxLength: 12 }).map((ops) => applyOps(ORSet.empty(), ops))

describe("ORSet — semilattice laws", () => {
  it("idempotent: merge(a, a) = a", () => {
    fc.assert(
      fc.property(setArb, (a) => {
        expect(ORSet.equals(ORSet.merge(a, a), a)).toBe(true)
      }),
    )
  })

  it("commutative: merge(a, b) = merge(b, a)", () => {
    fc.assert(
      fc.property(setArb, setArb, (a, b) => {
        expect(ORSet.equals(ORSet.merge(a, b), ORSet.merge(b, a))).toBe(true)
      }),
    )
  })

  it("associative: merge(merge(a, b), c) = merge(a, merge(b, c))", () => {
    fc.assert(
      fc.property(setArb, setArb, setArb, (a, b, c) => {
        expect(
          ORSet.equals(ORSet.merge(ORSet.merge(a, b), c), ORSet.merge(a, ORSet.merge(b, c))),
        ).toBe(true)
      }),
    )
  })
})

describe("ORSet — add wins over concurrent remove", () => {
  it("isolated add then remove ⇒ absent", () => {
    const s = ORSet.remove(ORSet.add(ORSet.empty<string>(), "x", "t1"), "x")
    expect(ORSet.has(s, "x")).toBe(false)
  })

  it("concurrent add (fresh tag) survives a remove of the prior tag", () => {
    const base = ORSet.add(ORSet.empty<string>(), "x", "t1")
    const aRemoved = ORSet.remove(base, "x")
    const bConcurrentAdd = ORSet.add(base, "x", "t2")
    const merged = ORSet.merge(aRemoved, bConcurrentAdd)
    expect(ORSet.has(merged, "x")).toBe(true)
  })

  it("values() lists every member with a live tag exactly once", () => {
    fc.assert(
      fc.property(setArb, (s) => {
        const values = ORSet.values(s)
        const unique = new Set(values)
        expect(values.length).toBe(unique.size)
        for (const v of values) expect(ORSet.has(s, v)).toBe(true)
      }),
    )
  })

  it("has on a missing value returns false", () => {
    expect(ORSet.has(ORSet.empty<string>(), "absent")).toBe(false)
  })

  it("remove on a missing value is a no-op", () => {
    const s = ORSet.empty<string>()
    expect(ORSet.remove(s, "absent")).toBe(s)
  })

  it("equals divergence cases", () => {
    const a = ORSet.add(ORSet.empty<string>(), "x", "t1")
    expect(ORSet.equals(a, ORSet.empty<string>())).toBe(false)
    const b = ORSet.add(ORSet.empty<string>(), "y", "t1")
    expect(ORSet.equals(a, b)).toBe(false)
    const c = ORSet.add(a, "x", "t2")
    expect(ORSet.equals(a, c)).toBe(false)
    const d = ORSet.remove(a, "x")
    expect(ORSet.equals(a, d)).toBe(false)
  })

  it("equals detects tag-set divergence within the same value", () => {
    const a: ORSet<string> = {
      elements: new Map([["x", new Set(["t1"])]]),
      tombstones: new Set(),
    }
    const b: ORSet<string> = {
      elements: new Map([["x", new Set(["t2"])]]),
      tombstones: new Set(),
    }
    expect(ORSet.equals(a, b)).toBe(false)
  })

  it("equals detects tombstone-set divergence of equal cardinality", () => {
    const a: ORSet<string> = {
      elements: new Map(),
      tombstones: new Set(["t1"]),
    }
    const b: ORSet<string> = {
      elements: new Map(),
      tombstones: new Set(["t2"]),
    }
    expect(ORSet.equals(a, b)).toBe(false)
  })
})
