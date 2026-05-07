import { Temporal } from "@js-temporal/polyfill"
import * as fc from "fast-check"
import { describe, expect, it } from "vitest"
import type { Confirmed } from "../../../src/domain/booking/Booking.js"
import { confirmedSlotLens } from "../../../src/domain/booking/optics.js"
import type { TimeSlot } from "../../../src/domain/value-objects/TimeSlot.js"
import { baseHeld } from "../../_fixtures/index.js"

const arbInstant = (offsetSec = 0) =>
  fc
    .integer({ min: 0, max: 1_000_000 })
    .map((n) => Temporal.Instant.fromEpochMilliseconds((1_700_000_000 + n + offsetSec) * 1000))

const arbSlot: fc.Arbitrary<TimeSlot> = fc.integer({ min: 0, max: 1_000_000 }).map((n) => {
  const start = Temporal.Instant.fromEpochMilliseconds((1_700_000_000 + n) * 1000)
  const end = Temporal.Instant.fromEpochMilliseconds((1_700_000_000 + n + 3600) * 1000)
  return { start, end }
})

const arbConfirmed: fc.Arbitrary<Confirmed> = arbInstant().map((confirmedAt) => {
  const held = baseHeld()
  return {
    ...held,
    state: "Confirmed",
    confirmedAt,
  } satisfies Confirmed
})

describe("confirmedSlotLens — Lens laws", () => {
  it("get-set: replace(get(s), s) ≡ s (property)", () => {
    fc.assert(
      fc.property(arbConfirmed, (s) => {
        const round = confirmedSlotLens.replace(confirmedSlotLens.get(s), s)
        return JSON.stringify(round) === JSON.stringify(s)
      }),
    )
  })

  it("set-get: get(replace(a, s)) ≡ a (property)", () => {
    fc.assert(
      fc.property(arbConfirmed, arbSlot, (s, a) => {
        const got = confirmedSlotLens.get(confirmedSlotLens.replace(a, s))
        return JSON.stringify(got) === JSON.stringify(a)
      }),
    )
  })

  it("set-set: replace(a2, replace(a1, s)) ≡ replace(a2, s) (property)", () => {
    fc.assert(
      fc.property(arbConfirmed, arbSlot, arbSlot, (s, a1, a2) => {
        const lhs = confirmedSlotLens.replace(a2, confirmedSlotLens.replace(a1, s))
        const rhs = confirmedSlotLens.replace(a2, s)
        return JSON.stringify(lhs) === JSON.stringify(rhs)
      }),
    )
  })

  it("preserves the Confirmed state through replace", () => {
    fc.assert(
      fc.property(arbConfirmed, arbSlot, (s, a) => {
        const next = confirmedSlotLens.replace(a, s)
        expect(next.state).toBe("Confirmed")
        return true
      }),
    )
  })
})
