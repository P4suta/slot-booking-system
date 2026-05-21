import { Temporal } from "@js-temporal/polyfill"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { bucketOf, intervalOf, type SlotGranularity } from "../../../src/domain/queue/Slot.js"
import { BusinessTimeZoneSchema } from "../../../src/domain/value-objects/BusinessTimeZone.js"

/**
 * FP-6 regression lock — `bucketOf` projects an `Instant` onto a
 * day-local bucket in the business time zone (ADR-0066). Earlier
 * reviews flagged the UTC/JST midnight boundary as a potential
 * precision risk because `Temporal.Instant.toZonedDateTimeISO`
 * carries nanosecond precision and a sloppy second-truncation could
 * walk the bucket id across midnight. These tests pin the round-trip:
 *
 *   - `2026-05-08T14:59:59.999999999Z` (JST 23:59) → last bucket of
 *     2026-05-08 (JST)
 *   - `2026-05-08T15:00:00.000000000Z` (JST 00:00 next day) → first
 *     bucket of 2026-05-09 (JST)
 *
 * If a future change accidentally truncates sub-second precision or
 * mixes UTC/JST in the bucket math, one of these assertions fires.
 */

const TZ = Schema.decodeUnknownSync(BusinessTimeZoneSchema)("Asia/Tokyo")

const at = (iso: string): Temporal.Instant => Temporal.Instant.from(iso)

describe("bucketOf — UTC/JST midnight boundary precision (FP-6)", () => {
  const granularities: readonly SlotGranularity[] = [15, 30, 60]

  for (const g of granularities) {
    it(`granularity=${String(g)}: 14:59:59.999...Z (JST 23:59) lands in the last bucket of that JST day`, () => {
      // 23:59 JST = 14:59 UTC the previous calendar day.
      const lastMinuteOfJstDay = at("2026-05-08T14:59:59.999999999Z")
      const bucket = bucketOf(lastMinuteOfJstDay, TZ, g)
      const bucketsPerDay = (24 * 60) / g
      // The minute is 23h*60 + 59 = 1439; integer-divide by `g`
      // gives the last bucket (`bucketsPerDay - 1`).
      expect(bucket).toBe(bucketsPerDay - 1)
    })

    it(`granularity=${String(g)}: 15:00:00.000Z (JST 00:00 next day) lands in bucket 0`, () => {
      const startOfNextJstDay = at("2026-05-08T15:00:00.000000000Z")
      const bucket = bucketOf(startOfNextJstDay, TZ, g)
      expect(bucket).toBe(0)
    })

    it(`granularity=${String(g)}: 14:59:59 vs 15:00:00 differ by one full day's buckets`, () => {
      const justBefore = at("2026-05-08T14:59:59.999999999Z")
      const justAfter = at("2026-05-08T15:00:00.000000000Z")
      const before = bucketOf(justBefore, TZ, g)
      const after = bucketOf(justAfter, TZ, g)
      const bucketsPerDay = (24 * 60) / g
      // Across the JST day boundary, the bucket id resets from
      // `bucketsPerDay - 1` to 0 — the same as wrapping mod
      // `bucketsPerDay`.
      expect((before + 1) % bucketsPerDay).toBe(after)
    })
  }

  it("intervalOf at bucket 0 of a fresh JST day starts exactly at JST 00:00", () => {
    const justAfter = at("2026-05-08T15:00:00.000000000Z")
    const slot = {
      date: justAfter.toZonedDateTimeISO(TZ).toPlainDate(),
      bucketId: bucketOf(justAfter, TZ, 30),
      granularity: 30 as SlotGranularity,
      capacity: 2,
    }
    const { startAt } = intervalOf(slot, TZ)
    // Round-trip start: 00:00 JST on the same date.
    expect(startAt.toString()).toBe("2026-05-08T15:00:00Z")
  })
})
