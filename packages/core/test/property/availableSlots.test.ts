import { Temporal } from "@js-temporal/polyfill"
import * as fc from "fast-check"
import { describe, expect, it } from "vitest"
import type { Booking, Confirmed } from "../../src/domain/booking/Booking.js"
import {
  type AvailableSlot,
  computeAvailableSlots,
  type SlotCalcEnv,
  type SlotCalcQuery,
} from "../../src/domain/slot/computeAvailableSlots.js"
import {
  baseEnv,
  baseQuery,
  baseService,
  confirmedBooking,
  PROVIDER_ID_A,
  PROVIDER_ID_B,
  RESOURCE_ID_1,
  RESOURCE_ID_2,
  slot as slotFx,
} from "../_fixtures/index.js"

/**
 * Phase 0.9-3 property suite for `computeAvailableSlots`.
 *
 * The output is a *list of candidate slots*, not a chosen schedule —
 * different starts on the same provider/resource intentionally
 * overlap (the user picks one). The properties pin invariants that
 * survive that semantics:
 *
 *   1. **Determinism** — `compute(env, query)` is a pure function, so
 *      calling it twice on identical inputs yields the same array.
 *   2. **Business-hours containment** — every emitted slot's
 *      `[start, end)` lies inside the day's open windows.
 *   3. **No collision with existing bookings on the assigned
 *      provider** — for each emitted slot S with provider P, no
 *      pre-existing Confirmed/Held booking with provider P overlaps
 *      with S's `[start - bufferBefore, end + bufferAfter)`.
 *   4. **No collision with existing bookings on the assigned
 *      resources** — for each emitted slot S using resource R, no
 *      pre-existing booking with R in its resourceIds overlaps with
 *      S's `[start, end)`.
 *   5. **Monotonic by start time** — the result is sorted ascending
 *      by start, so the UI can render without re-sorting.
 *
 * The arbitraries generate noise *around* the fixed `baseEnv()` —
 * random sets of pre-existing bookings inside the open hours — so the
 * search problem is well-formed (services + providers + resources are
 * the fixture's two each) while the booking pressure varies.
 */

const dayInTokyo = Temporal.PlainDate.from("2026-05-11")

const arbBookingHourStart = fc.integer({ min: 10, max: 16 }).map((h) => h)

const buildBooking = (
  providerId: typeof PROVIDER_ID_A,
  resourceId: typeof RESOURCE_ID_1,
  hour: number,
): Confirmed =>
  confirmedBooking({
    providerId,
    resourceIds: [resourceId],
    slot: slotFx(
      `2026-05-11T${String(hour - 9).padStart(2, "0")}:00:00Z`,
      `2026-05-11T${String(hour - 8).padStart(2, "0")}:00:00Z`,
    ),
  })

// 10:00..11:00 JST = 01:00..02:00 UTC; 18:00 JST = 09:00 UTC.
// JST = UTC + 9, so JST hour H = UTC (H - 9).

const arbBookings = fc
  .array(
    fc.tuple(
      fc.constantFrom(PROVIDER_ID_A, PROVIDER_ID_B),
      fc.constantFrom(RESOURCE_ID_1, RESOURCE_ID_2),
      arbBookingHourStart,
    ),
    { maxLength: 4 },
  )
  .map((triples): readonly Booking[] => triples.map(([p, r, h]) => buildBooking(p, r, h)))

const envWith = (existingBookings: readonly Booking[]): SlotCalcEnv => baseEnv({ existingBookings })

const queryAt = (now: Temporal.Instant): SlotCalcQuery =>
  baseQuery({ service: baseService, date: dayInTokyo, now })

const morning = Temporal.Instant.from("2026-05-11T00:00:00Z") // 09:00 JST, before opening

const slotMillis = (s: AvailableSlot): readonly [number, number] => [
  s.start.toInstant().epochMilliseconds,
  s.end.toInstant().epochMilliseconds,
]

const overlap = ([a, b]: readonly [number, number], [c, d]: readonly [number, number]): boolean =>
  a < d && c < b

describe("computeAvailableSlots property suite", () => {
  it("is deterministic — same inputs ⇒ identical outputs", () => {
    fc.assert(
      fc.property(arbBookings, (bookings) => {
        const env = envWith(bookings)
        const q = queryAt(morning)
        const a = computeAvailableSlots(env, q)
        const b = computeAvailableSlots(env, q)
        expect(a).toEqual(b)
      }),
      { numRuns: 30 },
    )
  })

  it("emits slots only inside the day's open windows", () => {
    fc.assert(
      fc.property(arbBookings, (bookings) => {
        const env = envWith(bookings)
        const slots = computeAvailableSlots(env, queryAt(morning))
        for (const s of slots) {
          // Open windows: 10:00..18:00 JST. Slot start ≥ 10 and end ≤ 18.
          expect(s.start.hour).toBeGreaterThanOrEqual(10)
          expect(s.end.hour).toBeLessThanOrEqual(18)
        }
      }),
      { numRuns: 30 },
    )
  })

  it("does not collide with existing bookings on the assigned provider", () => {
    fc.assert(
      fc.property(arbBookings, (bookings) => {
        const env = envWith(bookings)
        const slots = computeAvailableSlots(env, queryAt(morning))
        const bufferBefore = baseService.bufferBeforeMinutes
        const bufferAfter = baseService.bufferAfterMinutes
        for (const s of slots) {
          const sStart = s.start.toInstant().epochMilliseconds - bufferBefore * 60_000
          const sEnd = s.end.toInstant().epochMilliseconds + bufferAfter * 60_000
          for (const b of bookings) {
            if (b.state !== "Confirmed" && b.state !== "Held") continue
            if (b.providerId !== s.providerId) continue
            const bStart = b.slot.start.epochMilliseconds
            const bEnd = b.slot.end.epochMilliseconds
            expect(overlap([sStart, sEnd], [bStart, bEnd])).toBe(false)
          }
        }
      }),
      { numRuns: 30 },
    )
  })

  it("does not collide with existing bookings on the assigned resources", () => {
    fc.assert(
      fc.property(arbBookings, (bookings) => {
        const env = envWith(bookings)
        const slots = computeAvailableSlots(env, queryAt(morning))
        for (const s of slots) {
          const [sStart, sEnd] = slotMillis(s)
          for (const b of bookings) {
            if (b.state !== "Confirmed" && b.state !== "Held") continue
            const sharedResource = b.resourceIds.some((r) => s.resourceIds.includes(r))
            if (!sharedResource) continue
            const bStart = b.slot.start.epochMilliseconds
            const bEnd = b.slot.end.epochMilliseconds
            expect(overlap([sStart, sEnd], [bStart, bEnd])).toBe(false)
          }
        }
      }),
      { numRuns: 30 },
    )
  })

  it("the output is monotonically ordered by start time", () => {
    fc.assert(
      fc.property(arbBookings, (bookings) => {
        const slots = computeAvailableSlots(envWith(bookings), queryAt(morning))
        for (let i = 1; i < slots.length; i += 1) {
          const prev = slots[i - 1]
          const curr = slots[i]
          if (!prev || !curr) continue
          expect(Temporal.ZonedDateTime.compare(prev.start, curr.start)).toBeLessThanOrEqual(0)
        }
      }),
      { numRuns: 30 },
    )
  })
})
