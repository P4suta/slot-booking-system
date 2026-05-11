import { describe, expect, it } from "vitest"
import {
  dateOffsetIso,
  defaultDateTabs,
  labelOfBucket,
  parseSlotInstant,
  slotInstantOf,
  todayIso,
} from "../../src/lib/slotTime.js"

describe("slotTime helpers", () => {
  describe("todayIso / dateOffsetIso", () => {
    it("returns Y-M-D padded for the given Date", () => {
      const fixed = new Date(2026, 4, 11) // 2026-05-11 local
      expect(todayIso(fixed)).toBe("2026-05-11")
    })

    it("dateOffsetIso(0) === todayIso", () => {
      const fixed = new Date(2026, 11, 31)
      expect(dateOffsetIso(0, fixed)).toBe(todayIso(fixed))
    })

    it("dateOffsetIso rolls into next month / year", () => {
      expect(dateOffsetIso(1, new Date(2026, 11, 31))).toBe("2027-01-01")
      expect(dateOffsetIso(1, new Date(2026, 1, 28))).toBe("2026-03-01") // 2026 not leap
    })

    it("dateOffsetIso supports multi-day forward jumps", () => {
      const base = new Date(2026, 4, 11)
      expect(dateOffsetIso(2, base)).toBe("2026-05-13")
      expect(dateOffsetIso(7, base)).toBe("2026-05-18")
    })
  })

  describe("labelOfBucket", () => {
    it("formats granularity=30 buckets as HH:MM", () => {
      expect(labelOfBucket(0, 30)).toBe("00:00")
      expect(labelOfBucket(1, 30)).toBe("00:30")
      expect(labelOfBucket(28, 30)).toBe("14:00")
      expect(labelOfBucket(47, 30)).toBe("23:30")
    })

    it("formats granularity=15 / 60 buckets too", () => {
      expect(labelOfBucket(56, 15)).toBe("14:00") // 56*15 = 840 min = 14h
      expect(labelOfBucket(14, 60)).toBe("14:00")
    })
  })

  describe("slotInstantOf", () => {
    it("encodes a JST wall-clock pick as the corresponding UTC instant", () => {
      // 14:00 JST = 05:00 UTC (UTC+9, no DST).
      expect(slotInstantOf("2026-05-11", 28, 30)).toBe("2026-05-11T05:00:00.000Z")
      // 09:00 JST = 00:00 UTC same date — first business-hour bucket.
      expect(slotInstantOf("2026-05-11", 18, 30)).toBe("2026-05-11T00:00:00.000Z")
    })

    it("crosses the date boundary when the JST wall-clock is below the offset", () => {
      // 00:00 JST on 2026-12-31 = 15:00 UTC on 2026-12-30.
      expect(slotInstantOf("2026-12-31", 0, 30)).toBe("2026-12-30T15:00:00.000Z")
    })

    it("round-trips through parseSlotInstant for an in-hours bucket", () => {
      const iso = slotInstantOf("2026-07-04", 28, 30) // 14:00 JST
      const parsed = parseSlotInstant(iso, 30)
      expect(parsed).toEqual({ date: "2026-07-04", bucketId: 28 })
    })

    it("round-trips through parseSlotInstant for a near-midnight bucket (date crossover)", () => {
      const iso = slotInstantOf("2026-07-04", 0, 30) // 00:00 JST
      const parsed = parseSlotInstant(iso, 30)
      expect(parsed).toEqual({ date: "2026-07-04", bucketId: 0 })
    })
  })

  describe("parseSlotInstant", () => {
    it("returns null for null / undefined / malformed input", () => {
      expect(parseSlotInstant(null, 30)).toBeNull()
      expect(parseSlotInstant(undefined, 30)).toBeNull()
      expect(parseSlotInstant("", 30)).toBeNull()
      expect(parseSlotInstant("not-an-iso", 30)).toBeNull()
    })

    it("returns null when the JST minute value is not aligned to the granularity", () => {
      // UTC 05:15 → JST 14:15 → 14*60+15 = 855 min. 855 % 30 = 15 ≠ 0.
      expect(parseSlotInstant("2026-05-11T05:15:00.000Z", 30)).toBeNull()
      // 14:15 JST aligned for 15-min granularity → bucket 57.
      expect(parseSlotInstant("2026-05-11T05:15:00.000Z", 15)).toEqual({
        date: "2026-05-11",
        bucketId: 57,
      })
    })

    it("parses a UTC ISO into the JST wall-clock date + bucket", () => {
      // UTC 05:00 → JST 14:00 → bucket 28.
      expect(parseSlotInstant("2026-05-11T05:00:00.000Z", 30)).toEqual({
        date: "2026-05-11",
        bucketId: 28,
      })
      // UTC 00:30 → JST 09:30 → bucket 19.
      expect(parseSlotInstant("2026-05-11T00:30:00.000Z", 30)).toEqual({
        date: "2026-05-11",
        bucketId: 19,
      })
    })

    it("tolerates ISO variants without milliseconds", () => {
      expect(parseSlotInstant("2026-05-11T05:00:00Z", 30)).toEqual({
        date: "2026-05-11",
        bucketId: 28,
      })
    })
  })

  describe("defaultDateTabs", () => {
    it("returns 3 tabs labelled 今日 / 明日 / 明後日", () => {
      const tabs = defaultDateTabs(new Date(2026, 4, 11))
      expect(tabs).toEqual([
        { iso: "2026-05-11", label: "今日" },
        { iso: "2026-05-12", label: "明日" },
        { iso: "2026-05-13", label: "明後日" },
      ])
    })
  })
})
