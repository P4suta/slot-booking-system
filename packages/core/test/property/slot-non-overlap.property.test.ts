import { Temporal } from "@js-temporal/polyfill"
import { Schema } from "effect"
import * as fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
  ALL_SLOT_GRANULARITIES,
  type BucketId,
  bucketOf,
  bucketsPerDay,
  intervalOf,
  mergeOccupancy,
  overlaps,
  type Slot,
  ZERO_OCCUPANCY,
} from "../../src/domain/queue/Slot.js"
import { BusinessTimeZoneSchema } from "../../src/domain/value-objects/BusinessTimeZone.js"
import { numRuns } from "../_arb/numRuns.js"

/**
 * `overlaps` is the equivalence relation `(date, bucketId,
 * granularity)` on slots; the three Allen-algebra properties
 * (reflexive / symmetric / transitive) are the load-bearing
 * invariant ADR-0066's reservation lane builds on. The
 * `bucketOf` ↔ `intervalOf` round-trip is the morphism that
 * lets a future continuous-slot extension drop in without
 * breaking the public Schema. `mergeOccupancy` is the
 * commutative monoid that backs `slotOccupancy` aggregation
 * (ADR-0067).
 */

const tz = Schema.decodeUnknownSync(BusinessTimeZoneSchema)("Asia/Tokyo")

const arbSlot: fc.Arbitrary<Slot> = fc
  .constantFrom(...ALL_SLOT_GRANULARITIES)
  .chain((granularity) =>
    fc
      .record({
        year: fc.integer({ min: 2026, max: 2030 }),
        month: fc.integer({ min: 1, max: 12 }),
        day: fc.integer({ min: 1, max: 28 }),
        bucketRaw: fc.integer({ min: 0, max: bucketsPerDay(granularity) - 1 }),
        capacity: fc.integer({ min: 1, max: 10 }),
      })
      .map(
        ({ year, month, day, bucketRaw, capacity }): Slot => ({
          date: Temporal.PlainDate.from({ year, month, day }),
          bucketId: bucketRaw as unknown as BucketId,
          granularity,
          capacity,
        }),
      ),
  )

describe("Slot — Allen interval algebra (fixed bucket grid)", () => {
  it("reflexive: overlaps(a, a) is always true", () => {
    fc.assert(
      fc.property(arbSlot, (a) => {
        expect(overlaps(a, a)).toBe(true)
      }),
      { numRuns: numRuns(50, 200) },
    )
  })

  it("symmetric: overlaps(a, b) === overlaps(b, a)", () => {
    fc.assert(
      fc.property(arbSlot, arbSlot, (a, b) => {
        expect(overlaps(a, b)).toBe(overlaps(b, a))
      }),
      { numRuns: numRuns(100, 400) },
    )
  })

  it("transitive: overlaps(a, b) ∧ overlaps(b, c) ⇒ overlaps(a, c)", () => {
    fc.assert(
      fc.property(arbSlot, arbSlot, arbSlot, (a, b, c) => {
        if (overlaps(a, b) && overlaps(b, c)) {
          expect(overlaps(a, c)).toBe(true)
        }
      }),
      { numRuns: numRuns(200, 800) },
    )
  })

  it("granularity-disjoint: different granularities never overlap", () => {
    fc.assert(
      fc.property(arbSlot, arbSlot, (a, b) => {
        if (a.granularity !== b.granularity) {
          expect(overlaps(a, b)).toBe(false)
        }
      }),
      { numRuns: numRuns(100, 400) },
    )
  })
})

describe("Slot — bucketOf ↔ intervalOf morphism", () => {
  it("bucketOf(intervalOf(slot).startAt) === slot.bucketId", () => {
    fc.assert(
      fc.property(arbSlot, (slot) => {
        const { startAt } = intervalOf(slot, tz)
        const recovered = bucketOf(startAt, tz, slot.granularity)
        expect(recovered).toBe(slot.bucketId)
      }),
      { numRuns: numRuns(100, 400) },
    )
  })

  it("intervalOf(slot).endAt - startAt === granularity minutes", () => {
    fc.assert(
      fc.property(arbSlot, (slot) => {
        const { startAt, endAt } = intervalOf(slot, tz)
        const elapsedMs = endAt.epochMilliseconds - startAt.epochMilliseconds
        expect(elapsedMs).toBe(slot.granularity * 60 * 1000)
      }),
      { numRuns: numRuns(100, 400) },
    )
  })
})

describe("Slot — mergeOccupancy commutative monoid", () => {
  const arbCount = fc.integer({ min: 0, max: 1000 })

  it("commutative: merge(a, b) === merge(b, a)", () => {
    fc.assert(
      fc.property(arbCount, arbCount, (a, b) => {
        expect(mergeOccupancy(a, b)).toBe(mergeOccupancy(b, a))
      }),
      { numRuns: numRuns(50, 200) },
    )
  })

  it("associative: merge(merge(a, b), c) === merge(a, merge(b, c))", () => {
    fc.assert(
      fc.property(arbCount, arbCount, arbCount, (a, b, c) => {
        expect(mergeOccupancy(mergeOccupancy(a, b), c)).toBe(
          mergeOccupancy(a, mergeOccupancy(b, c)),
        )
      }),
      { numRuns: numRuns(50, 200) },
    )
  })

  it("identity: merge(a, ZERO_OCCUPANCY) === a", () => {
    fc.assert(
      fc.property(arbCount, (a) => {
        expect(mergeOccupancy(a, ZERO_OCCUPANCY)).toBe(a)
      }),
      { numRuns: numRuns(50, 200) },
    )
  })
})
