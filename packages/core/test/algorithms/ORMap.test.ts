import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { ORMap } from "../../src/algorithms/ORMap.js"

type Op =
  | { readonly kind: "set"; readonly key: string; readonly tag: string; readonly value: number }
  | { readonly kind: "remove"; readonly key: string }

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc
    .tuple(fc.constantFrom("k1", "k2", "k3"), fc.uuid(), fc.integer({ min: 0, max: 100 }))
    .map(([key, tag, value]): Op => ({ kind: "set", key, tag, value })),
  fc.constantFrom("k1", "k2", "k3").map((key): Op => ({ kind: "remove", key })),
)

const applyOps = (start: ORMap<string, number>, ops: readonly Op[]): ORMap<string, number> =>
  ops.reduce<ORMap<string, number>>(
    (acc, op) =>
      op.kind === "set" ? ORMap.set(acc, op.key, op.tag, op.value) : ORMap.remove(acc, op.key),
    start,
  )

const mapArb = fc
  .array(opArb, { maxLength: 12 })
  .map((ops) => applyOps(ORMap.empty<string, number>(), ops))

const numEquals = (a: number, b: number): boolean => a === b

describe("ORMap — semilattice laws", () => {
  it("idempotent: merge(a, a) = a", () => {
    fc.assert(
      fc.property(mapArb, (a) => {
        expect(ORMap.equals(ORMap.merge(a, a), a, numEquals)).toBe(true)
      }),
    )
  })

  it("commutative: merge(a, b) = merge(b, a)", () => {
    fc.assert(
      fc.property(mapArb, mapArb, (a, b) => {
        expect(ORMap.equals(ORMap.merge(a, b), ORMap.merge(b, a), numEquals)).toBe(true)
      }),
    )
  })

  it("associative: merge(merge(a, b), c) = merge(a, merge(b, c))", () => {
    fc.assert(
      fc.property(mapArb, mapArb, mapArb, (a, b, c) => {
        expect(
          ORMap.equals(
            ORMap.merge(ORMap.merge(a, b), c),
            ORMap.merge(a, ORMap.merge(b, c)),
            numEquals,
          ),
        ).toBe(true)
      }),
    )
  })
})

describe("ORMap — observed-remove semantics", () => {
  it("set then get returns the value", () => {
    const m = ORMap.set(ORMap.empty<string, number>(), "k", "t1", 42)
    expect(ORMap.get(m, "k")).toBe(42)
  })

  it("remove tombstones every observed tag", () => {
    const m = ORMap.set(ORMap.empty<string, number>(), "k", "t1", 42)
    const removed = ORMap.remove(m, "k")
    expect(ORMap.get(removed, "k")).toBeUndefined()
  })

  it("concurrent set + remove ⇒ set wins (fresh tag survives)", () => {
    const base = ORMap.set(ORMap.empty<string, number>(), "k", "t1", 1)
    const aRemoved = ORMap.remove(base, "k")
    const bConcurrentSet = ORMap.set(base, "k", "t2", 2)
    const merged = ORMap.merge(aRemoved, bConcurrentSet)
    expect(ORMap.get(merged, "k")).toBe(2)
  })

  it("default resolver picks the highest tag", () => {
    let m = ORMap.empty<string, number>()
    m = ORMap.set(m, "k", "t1", 1)
    m = ORMap.set(m, "k", "t3", 3)
    m = ORMap.set(m, "k", "t2", 2)
    expect(ORMap.get(m, "k")).toBe(3)
  })

  it("keys() lists every present key", () => {
    fc.assert(
      fc.property(mapArb, (m) => {
        for (const k of ORMap.keys(m)) {
          expect(ORMap.get(m, k)).not.toBeUndefined()
        }
      }),
    )
  })

  it("get on a missing key returns undefined", () => {
    expect(ORMap.get(ORMap.empty<string, number>(), "absent")).toBeUndefined()
  })

  it("remove on a missing key is a no-op", () => {
    const m = ORMap.empty<string, number>()
    expect(ORMap.remove(m, "absent")).toBe(m)
  })

  it("equals returns false on size mismatch / value mismatch / tombstone divergence", () => {
    const base = ORMap.set(ORMap.empty<string, number>(), "k", "t1", 1)
    expect(ORMap.equals(ORMap.empty<string, number>(), base, numEquals)).toBe(false)
    const otherKey = ORMap.set(ORMap.empty<string, number>(), "k2", "t2", 2)
    expect(ORMap.equals(base, otherKey, numEquals)).toBe(false)
    const sameKeyDiffValue = ORMap.set(ORMap.empty<string, number>(), "k", "t1", 99)
    expect(ORMap.equals(base, sameKeyDiffValue, numEquals)).toBe(false)
    const tombstoned = ORMap.remove(base, "k")
    expect(ORMap.equals(base, tombstoned, numEquals)).toBe(false)
    const sameTagDifferentTombstone = ORMap.set(ORMap.empty<string, number>(), "k", "t1", 1)
    expect(ORMap.equals(sameTagDifferentTombstone, base, numEquals)).toBe(true)
    const extraTag = ORMap.set(base, "k", "t2", 1)
    expect(ORMap.equals(extraTag, base, numEquals)).toBe(false)
  })

  it("equals detects tombstone-set divergence of equal cardinality", () => {
    const a: ORMap<string, number> = {
      entries: new Map(),
      tombstones: new Set(["t1"]),
    }
    const b: ORMap<string, number> = {
      entries: new Map(),
      tombstones: new Set(["t2"]),
    }
    expect(a.tombstones.size).toBe(b.tombstones.size)
    expect(ORMap.equals(a, b, numEquals)).toBe(false)
  })
})
