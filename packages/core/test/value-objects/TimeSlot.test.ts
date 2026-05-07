import { Temporal } from "@js-temporal/polyfill"
import { Result } from "effect"
import { describe, expect, it } from "vitest"
import {
  containedIn,
  durationMinutes,
  makeTimeSlot,
  overlaps,
  type TimeSlot,
} from "../../src/domain/value-objects/TimeSlot.js"

const at = (iso: string): Temporal.Instant => Temporal.Instant.from(iso)

const slot = (startIso: string, endIso: string): TimeSlot => {
  const r = makeTimeSlot(at(startIso), at(endIso))
  if (Result.isFailure(r)) throw new Error(`bad slot: ${r.failure._tag}`)
  return r.success
}

describe("TimeSlot", () => {
  it("rejects start ≥ end", () => {
    const r = makeTimeSlot(at("2026-05-05T10:00:00Z"), at("2026-05-05T10:00:00Z"))
    expect(Result.isFailure(r)).toBe(true)
  })

  it("computes whole-minute duration", () => {
    expect(durationMinutes(slot("2026-05-05T10:00:00Z", "2026-05-05T10:30:00Z"))).toBe(30)
    expect(durationMinutes(slot("2026-05-05T10:00:00Z", "2026-05-05T13:30:00Z"))).toBe(210)
  })

  it("touching boundaries do not overlap", () => {
    const a = slot("2026-05-05T10:00:00Z", "2026-05-05T11:00:00Z")
    const b = slot("2026-05-05T11:00:00Z", "2026-05-05T12:00:00Z")
    expect(overlaps(a, b)).toBe(false)
    expect(overlaps(b, a)).toBe(false)
  })

  it("strictly overlapping intervals report true", () => {
    const a = slot("2026-05-05T10:00:00Z", "2026-05-05T11:00:00Z")
    const b = slot("2026-05-05T10:30:00Z", "2026-05-05T11:30:00Z")
    expect(overlaps(a, b)).toBe(true)
    expect(overlaps(b, a)).toBe(true)
  })

  it("containment is asymmetric", () => {
    const day = slot("2026-05-05T00:00:00Z", "2026-05-06T00:00:00Z")
    const morn = slot("2026-05-05T09:00:00Z", "2026-05-05T11:00:00Z")
    expect(containedIn(morn, day)).toBe(true)
    expect(containedIn(day, morn)).toBe(false)
  })
})
