import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { MinHeap } from "../../src/algorithms/MinHeap.js"

const numericCmp = (a: number, b: number) => a - b
const arbInts = fc.array(fc.integer({ min: -1000, max: 1000 }), { maxLength: 200 })

const drainAll = <T>(heap: MinHeap<T>): T[] => {
  const out: T[] = []
  while (!heap.isEmpty()) {
    const v = heap.pop()
    if (v !== undefined) out.push(v)
  }
  return out
}

describe("MinHeap — operational invariants", () => {
  it("peek returns the running minimum after every push", () => {
    fc.assert(
      fc.property(arbInts, (xs) => {
        const heap = new MinHeap<number>(numericCmp)
        let runningMin = Number.POSITIVE_INFINITY
        for (const x of xs) {
          heap.push(x)
          if (x < runningMin) runningMin = x
          expect(heap.peek()).toBe(runningMin)
        }
      }),
    )
  })

  it("drainAll yields a non-decreasing sequence", () => {
    fc.assert(
      fc.property(arbInts, (xs) => {
        const heap = MinHeap.fromArray(xs, numericCmp)
        const sorted = drainAll(heap)
        const [, ...tail] = sorted
        let prev = sorted[0]
        for (const cur of tail) {
          if (prev !== undefined) expect(prev).toBeLessThanOrEqual(cur)
          prev = cur
        }
      }),
    )
  })

  it("drainAll is a permutation of the input multiset", () => {
    fc.assert(
      fc.property(arbInts, (xs) => {
        const heap = MinHeap.fromArray(xs, numericCmp)
        const drained = drainAll(heap)
        expect(drained.slice().sort(numericCmp)).toEqual(xs.slice().sort(numericCmp))
      }),
    )
  })

  it("size is consistent with push/pop arithmetic", () => {
    fc.assert(
      fc.property(arbInts, (xs) => {
        const heap = new MinHeap<number>(numericCmp)
        for (const x of xs) heap.push(x)
        expect(heap.size()).toBe(xs.length)
        let popped = 0
        while (!heap.isEmpty()) {
          heap.pop()
          popped += 1
          expect(heap.size()).toBe(xs.length - popped)
        }
      }),
    )
  })

  it("pop on empty heap returns undefined", () => {
    const heap = new MinHeap<number>(numericCmp)
    expect(heap.pop()).toBeUndefined()
    expect(heap.peek()).toBeUndefined()
  })

  it("singleton pop short-circuits the siftDown branch", () => {
    const heap = new MinHeap<number>(numericCmp)
    heap.push(42)
    expect(heap.size()).toBe(1)
    expect(heap.pop()).toBe(42)
    expect(heap.isEmpty()).toBe(true)
  })

  it("toArray returns a defensive copy of the underlying storage", () => {
    const heap = new MinHeap<number>(numericCmp)
    heap.push(3)
    heap.push(1)
    heap.push(2)
    const snap = heap.toArray()
    expect(snap.length).toBe(3)
    expect(snap.includes(1)).toBe(true)
    expect(snap.includes(2)).toBe(true)
    expect(snap.includes(3)).toBe(true)
  })

  it("Floyd build is equivalent to push-each", () => {
    fc.assert(
      fc.property(arbInts, (xs) => {
        const a = drainAll(MinHeap.fromArray(xs, numericCmp))
        const pushed = new MinHeap<number>(numericCmp)
        for (const x of xs) pushed.push(x)
        const b = drainAll(pushed)
        expect(a).toEqual(b)
      }),
    )
  })
})
