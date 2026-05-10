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
    it("encodes date + bucket as ISO Z", () => {
      expect(slotInstantOf("2026-05-11", 28, 30)).toBe("2026-05-11T14:00:00.000Z")
      expect(slotInstantOf("2026-12-31", 0, 30)).toBe("2026-12-31T00:00:00.000Z")
    })

    it("round-trips through parseSlotInstant", () => {
      const iso = slotInstantOf("2026-07-04", 35, 30) // 17:30
      const parsed = parseSlotInstant(iso, 30)
      expect(parsed).toEqual({ date: "2026-07-04", bucketId: 35 })
    })
  })

  describe("parseSlotInstant", () => {
    it("returns null for null / undefined / malformed input", () => {
      expect(parseSlotInstant(null, 30)).toBeNull()
      expect(parseSlotInstant(undefined, 30)).toBeNull()
      expect(parseSlotInstant("", 30)).toBeNull()
      expect(parseSlotInstant("not-an-iso", 30)).toBeNull()
    })

    it("returns null when the minute value is not aligned to the granularity", () => {
      // 14:15 with granularity 30 is misaligned
      expect(parseSlotInstant("2026-05-11T14:15:00.000Z", 30)).toBeNull()
      // 14:15 with granularity 15 is aligned
      expect(parseSlotInstant("2026-05-11T14:15:00.000Z", 15)).toEqual({
        date: "2026-05-11",
        bucketId: 57,
      })
    })

    it("parses well-formed ISO into date + bucket", () => {
      expect(parseSlotInstant("2026-05-11T14:00:00.000Z", 30)).toEqual({
        date: "2026-05-11",
        bucketId: 28,
      })
      expect(parseSlotInstant("2026-05-11T09:30:00.000Z", 30)).toEqual({
        date: "2026-05-11",
        bucketId: 19,
      })
    })

    it("tolerates ISO variants without ms (still Z-suffixed instants)", () => {
      expect(parseSlotInstant("2026-05-11T14:00:00Z", 30)).toEqual({
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
