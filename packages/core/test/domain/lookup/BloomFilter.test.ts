import * as fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
  add,
  type BloomFilter,
  contains,
  empty,
  popcount,
} from "../../../src/domain/lookup/BloomFilter.js"

describe("BloomFilter constructors", () => {
  it("starts empty", () => {
    const bf = empty(1024, 4)
    expect(popcount(bf)).toBe(0)
  })

  it.each([
    ["zero size", 0, 4],
    ["negative size", -1, 4],
    ["non-integer size", 1.5, 4],
    ["zero hashCount", 1024, 0],
    ["negative hashCount", 1024, -1],
    ["non-integer hashCount", 1024, 2.5],
    ["hashCount over MAX", 1024, 33],
  ])("rejects invalid params: %s", (_label, size, hashCount) => {
    expect(() => empty(size, hashCount)).toThrow(RangeError)
  })
})

describe("contains / add", () => {
  it("an empty filter answers `false` for any key", () => {
    const bf = empty(1024, 4)
    expect(contains(bf, "anything")).toBe(false)
  })

  it("an added key is then contained", () => {
    const bf = add(empty(1024, 4), "abc-123")
    expect(contains(bf, "abc-123")).toBe(true)
  })

  it("popcount grows as keys are added", () => {
    let bf = empty(1024, 4)
    const before = popcount(bf)
    bf = add(bf, "k1")
    bf = add(bf, "k2")
    bf = add(bf, "k3")
    expect(popcount(bf)).toBeGreaterThan(before)
  })
})

describe("Bloom filter invariants", () => {
  it("property: no false negatives — every added key is reported as present", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.stringMatching(/^[A-Za-z0-9]{1,20}$/), { maxLength: 200 }),
        (keys) => {
          const bf = keys.reduce<BloomFilter>((acc, k) => add(acc, k), empty(8192, 6))
          for (const k of keys) {
            if (!contains(bf, k)) return false
          }
          return true
        },
      ),
      { numRuns: 50 },
    )
  })

  it("false-positive rate stays well below 5 % at design load (n=200, m=8192, k=6)", () => {
    const inserted = Array.from({ length: 200 }, (_, i) => `key-${i}`)
    const bf = inserted.reduce<BloomFilter>((acc, k) => add(acc, k), empty(8192, 6))
    let collisions = 0
    const probes = 5000
    for (let i = 0; i < probes; i++) {
      const probe = `probe-${i}`
      if (contains(bf, probe)) collisions++
    }
    // Theoretical FP for k=6, m=8192, n=200 is ≈ 0.0024 %; margin × 200.
    expect(collisions / probes).toBeLessThan(0.005)
  })

  it("idempotent add: re-inserting an existing key does not change the filter", () => {
    const bf1 = add(empty(1024, 4), "k")
    const bf2 = add(bf1, "k")
    expect(bf2.bits).toBe(bf1.bits)
  })
})
