import { Temporal } from "@js-temporal/polyfill"
import * as fc from "fast-check"
import { describe, expect, it } from "vitest"
import type { Booking, Confirmed } from "../../src/domain/booking/Booking.js"
import type { Closure } from "../../src/domain/entities/Closure.js"
import type { Service } from "../../src/domain/entities/Service.js"
import {
  type AvailableSlot,
  computeAvailableSlots,
} from "../../src/domain/slot/computeAvailableSlots.js"
import {
  type ClosureId,
  newServiceId,
  type ProviderAbsenceId,
  type ProviderId,
  type ServiceId,
} from "../../src/domain/types/EntityId.js"
import { minutesUnchecked } from "../../src/domain/value-objects/Duration.js"
import {
  baseEnv,
  baseQuery,
  baseService,
  bhAllWeekdays,
  confirmedBooking,
  date,
  holdingDays,
  PROVIDER_ID_A,
  PROVIDER_ID_B,
  providerA,
  RESOURCE_ID_1,
  RESOURCE_ID_2,
  resourceType,
  SERVICE_ID,
  skill,
  slot,
  weekday,
} from "../_fixtures/index.js"

describe("computeAvailableSlots", () => {
  it("returns slots only within business hours", () => {
    const out = computeAvailableSlots(baseEnv(), baseQuery())
    expect(out.length).toBeGreaterThan(0)
    for (const s of out) {
      expect(s.start.hour).toBeGreaterThanOrEqual(10)
      expect(s.end.hour).toBeLessThanOrEqual(18)
    }
  })

  it("returns empty on a closure date", () => {
    const closure: Closure = {
      id: "clos_x" as ClosureId,
      date: date("2026-05-11"),
      reason: "test",
    }
    expect(computeAvailableSlots(baseEnv({ closures: [closure] }), baseQuery())).toEqual([])
  })

  it("returns empty when business hours are missing for the weekday", () => {
    const monBh = bhAllWeekdays.get(weekday(1))
    if (!monBh) throw new Error("unreachable")
    const onlyMon = new Map([[weekday(1), monBh]])
    const sunday = date("2026-05-10") // Sunday
    expect(
      computeAvailableSlots(
        baseEnv({ businessHoursByWeekday: onlyMon }),
        baseQuery({ date: sunday }),
      ),
    ).toEqual([])
  })

  it("returns empty when slot granularity is non-positive", () => {
    expect(computeAvailableSlots(baseEnv({ slotGranularityMinutes: 0 }), baseQuery())).toEqual([])
    expect(computeAvailableSlots(baseEnv({ slotGranularityMinutes: -5 }), baseQuery())).toEqual([])
  })

  it("returns empty when service is disabled", () => {
    const disabled: Service = { ...baseService, enabled: false }
    expect(
      computeAvailableSlots(
        baseEnv({ servicesById: new Map([[SERVICE_ID, disabled]]) }),
        baseQuery({ service: disabled }),
      ),
    ).toEqual([])
  })

  it("clears past minutes when the target date is today", () => {
    // Now = 2026-05-11 13:00 JST = 04:00 UTC, target date = 2026-05-11 JST.
    const now = Temporal.Instant.from("2026-05-11T04:00:00Z")
    const out = computeAvailableSlots(baseEnv(), baseQuery({ now }))
    for (const s of out) {
      expect(s.start.hour).toBeGreaterThanOrEqual(13)
    }
  })

  it("returns empty for a date entirely in the past", () => {
    const yesterday = date("2026-05-10")
    const now = Temporal.Instant.from("2026-05-11T04:00:00Z")
    expect(computeAvailableSlots(baseEnv(), baseQuery({ date: yesterday, now }))).toEqual([])
  })

  it("subtracts an existing booking from provider availability with buffer", () => {
    // Service requires 60 + 15 buffer-after = 75 minutes total provider.
    // Existing booking 13:00..14:00 JST occupies provider A;
    // provider B is free, so the slot should be fillable by B.
    const occupied = confirmedBooking({
      providerId: PROVIDER_ID_A,
      resourceIds: [RESOURCE_ID_1],
      slot: slot("2026-05-11T04:00:00Z", "2026-05-11T05:00:00Z"), // 13:00..14:00 JST
    })
    const out = computeAvailableSlots(baseEnv({ existingBookings: [occupied] }), baseQuery())
    const at13 = out.find((s) => s.start.hour === 13 && s.start.minute === 0)
    expect(at13?.providerId).toBe(PROVIDER_ID_B)
  })

  it("disappears slot when both providers are booked", () => {
    const t1 = slot("2026-05-11T04:00:00Z", "2026-05-11T05:00:00Z")
    const t2 = slot("2026-05-11T04:00:00Z", "2026-05-11T05:00:00Z")
    const out = computeAvailableSlots(
      baseEnv({
        existingBookings: [
          confirmedBooking({
            providerId: PROVIDER_ID_A,
            resourceIds: [RESOURCE_ID_1],
            slot: t1,
          }),
          confirmedBooking({
            providerId: PROVIDER_ID_B,
            resourceIds: [RESOURCE_ID_2],
            slot: t2,
          }),
        ],
      }),
      baseQuery(),
    )
    const at13 = out.find((s) => s.start.hour === 13 && s.start.minute === 0)
    expect(at13).toBeUndefined()
  })

  it("respects required-resource-type — empty if no matching type", () => {
    const otherType = resourceType("storage")
    const svc: Service = { ...baseService, requiredResourceTypes: new Set([otherType]) }
    const out = computeAvailableSlots(
      baseEnv({ servicesById: new Map([[SERVICE_ID, svc]]) }),
      baseQuery({ service: svc }),
    )
    expect(out).toEqual([])
  })

  it("provider's required skill filters out non-matching providers", () => {
    const electric = skill("electric_assist")
    const electricService: Service = {
      ...baseService,
      requiredSkills: new Set([electric]),
    }
    const out = computeAvailableSlots(
      baseEnv({ servicesById: new Map([[SERVICE_ID, electricService]]) }),
      baseQuery({ service: electricService }),
    )
    expect(out).toEqual([]) // no provider has the skill
  })

  it("is deterministic — same input twice yields the same output", () => {
    const env = baseEnv()
    const q = baseQuery()
    expect(JSON.stringify(computeAvailableSlots(env, q))).toBe(
      JSON.stringify(computeAvailableSlots(env, q)),
    )
  })

  describe("invariants — property tests", () => {
    it("invariant 1: every output slot is within business hours", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 15, max: 60 }),
          fc.integer({ min: 30, max: 240 }).filter((n) => n % 15 === 0),
          (G, D) => {
            const svc: Service = {
              ...baseService,
              durationMinutes: minutesUnchecked(D),
              bufferAfterMinutes: minutesUnchecked(0),
            }
            const out = computeAvailableSlots(
              baseEnv({
                servicesById: new Map([[SERVICE_ID, svc]]),
                slotGranularityMinutes: G,
              }),
              baseQuery({ service: svc }),
            )
            for (const s of out) {
              if (s.start.hour < 10) return false
              if (s.end.hour > 18 || (s.end.hour === 18 && s.end.minute > 0)) return false
            }
            return true
          },
        ),
        { numRuns: 200 },
      )
    })

    it("invariant 2: provider not double-booked across output slots", () => {
      const svc: Service = { ...baseService, bufferAfterMinutes: minutesUnchecked(0) }
      const out = computeAvailableSlots(
        baseEnv({
          servicesById: new Map([[SERVICE_ID, svc]]),
          slotGranularityMinutes: 60,
        }),
        baseQuery({ service: svc }),
      )
      const byProvider = new Map<ProviderId, AvailableSlot[]>()
      for (const s of out) {
        const list = byProvider.get(s.providerId) ?? []
        list.push(s)
        byProvider.set(s.providerId, list)
      }
      for (const list of byProvider.values()) {
        list.sort((a, b) => Temporal.Instant.compare(a.start.toInstant(), b.start.toInstant()))
        for (let i = 1; i < list.length; i++) {
          const prev = list[i - 1]
          const cur = list[i]
          if (!prev || !cur) throw new Error("unreachable")
          expect(Temporal.Instant.compare(prev.end.toInstant(), cur.start.toInstant()) <= 0).toBe(
            true,
          )
        }
      }
    })

    it("invariant 3: monotonic — adding a booking cannot increase the output count", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 8 }), // booking start hour (10..18)
          (h) => {
            const start = h + 10
            if (start + 1 > 18) return true
            const startInstant = `2026-05-11T${(start - 9).toString().padStart(2, "0")}:00:00Z`
            const endInstant = `2026-05-11T${(start - 8).toString().padStart(2, "0")}:00:00Z`
            const occupied = confirmedBooking({
              providerId: PROVIDER_ID_A,
              resourceIds: [RESOURCE_ID_1],
              slot: slot(startInstant, endInstant),
            })
            const before = computeAvailableSlots(baseEnv(), baseQuery()).length
            const after = computeAvailableSlots(
              baseEnv({ existingBookings: [occupied] }),
              baseQuery(),
            ).length
            return after <= before
          },
        ),
        { numRuns: 50 },
      )
    })

    it("invariant 4: works at multiple granularities (count is non-zero for each)", () => {
      for (const G of [15, 30, 60]) {
        const out = computeAvailableSlots(baseEnv({ slotGranularityMinutes: G }), baseQuery())
        expect(out.length).toBeGreaterThan(0)
      }
    })

    it("invariant 5: deterministic ordering — output sorted by start", () => {
      const out = computeAvailableSlots(baseEnv(), baseQuery())
      for (let i = 1; i < out.length; i++) {
        const prev = out[i - 1]
        const cur = out[i]
        if (!prev || !cur) throw new Error("unreachable")
        expect(
          Temporal.Instant.compare(prev.start.toInstant(), cur.start.toInstant()),
        ).toBeLessThanOrEqual(0)
      }
    })
  })

  describe("multi-day holding period", () => {
    it("blocks the resource on every day within [bookingDate, bookingDate + holdingDays]", () => {
      // Service with holdingDays = 2 — the rack stays held through D+2.
      const overhaul = holdingDays(2)
      const overhaulSvc: Service = { ...baseService, holdingDays: overhaul }
      const overhaulId = "serv_overhaul" as ServiceId
      // Existing booking on 2026-05-09 (Sat) holds rsrc_111 through 2026-05-11.
      const existing: Confirmed = {
        ...confirmedBooking({
          providerId: PROVIDER_ID_A,
          resourceIds: [RESOURCE_ID_1],
          slot: slot("2026-05-09T01:00:00Z", "2026-05-09T02:00:00Z"),
        }),
        serviceId: overhaulId,
      }
      const out = computeAvailableSlots(
        baseEnv({
          servicesById: new Map([
            [SERVICE_ID, overhaulSvc],
            [overhaulId, { ...overhaulSvc, id: overhaulId }],
          ]),
          existingBookings: [existing],
        }),
        baseQuery({ service: { ...overhaulSvc, id: overhaulId } }),
      )
      // Some slots may still be served by RESOURCE_ID_2; never by RESOURCE_ID_1.
      for (const s of out) {
        expect(s.resourceIds).not.toContain(RESOURCE_ID_1)
      }
    })

    it("releases the resource the day after the holding period ends", () => {
      const oneDay = holdingDays(1)
      const oneDaySvc: Service = { ...baseService, holdingDays: oneDay }
      const overhaulId = "serv_oneday" as ServiceId
      // Existing booking on 2026-05-09 with holdingDays=1 holds through 2026-05-10.
      // Asking for 2026-05-11 should NOT be blocked.
      const existing: Confirmed = {
        ...confirmedBooking({
          providerId: PROVIDER_ID_A,
          resourceIds: [RESOURCE_ID_1],
          slot: slot("2026-05-09T01:00:00Z", "2026-05-09T02:00:00Z"),
        }),
        serviceId: overhaulId,
      }
      const out = computeAvailableSlots(
        baseEnv({
          servicesById: new Map([[overhaulId, { ...oneDaySvc, id: overhaulId }]]),
          existingBookings: [existing],
        }),
        baseQuery({ service: { ...oneDaySvc, id: overhaulId } }),
      )
      // RESOURCE_ID_1 should be free again on 2026-05-11.
      expect(out.some((s) => s.resourceIds.includes(RESOURCE_ID_1))).toBe(true)
    })
  })

  describe("unresolved-service bookings", () => {
    it("silently skips bookings whose serviceId is not in servicesById", () => {
      const orphanService = "serv_orphan" as ServiceId
      const orphanBooking = {
        ...confirmedBooking({
          providerId: PROVIDER_ID_A,
          resourceIds: [RESOURCE_ID_1],
          slot: slot("2026-05-11T04:00:00Z", "2026-05-11T05:00:00Z"),
        }),
        serviceId: orphanService,
      }
      // servicesById does NOT contain orphanService.
      const out = computeAvailableSlots(baseEnv({ existingBookings: [orphanBooking] }), baseQuery())
      // The orphan booking is effectively a no-op: provider A and
      // resource 1 stay free at 13:00 JST.
      const at13 = out.find((s) => s.start.hour === 13 && s.start.minute === 0)
      expect(at13?.providerId).toBe(PROVIDER_ID_A)
      expect(at13?.resourceIds).toContain(RESOURCE_ID_1)
    })
  })

  describe("provider absences", () => {
    it("clears the absence interval from the provider's mask", () => {
      const absence = {
        id: "absn_a" as ProviderAbsenceId,
        providerId: PROVIDER_ID_A,
        start: Temporal.Instant.from("2026-05-11T02:00:00Z"), // 11:00 JST
        end: Temporal.Instant.from("2026-05-11T04:00:00Z"), //   13:00 JST
        reason: "appt",
      }
      // Use a buffer-free service so the only thing affecting availability
      // is the absence itself.
      const noBufferSvc: Service = {
        ...baseService,
        bufferAfterMinutes: minutesUnchecked(0),
      }
      const out = computeAvailableSlots(
        baseEnv({
          servicesById: new Map([[SERVICE_ID, noBufferSvc]]),
          // Single provider so we observe the absence directly.
          providers: [providerA],
          providerAbsences: [absence],
          slotGranularityMinutes: 60,
        }),
        baseQuery({ service: noBufferSvc }),
      )
      const has = (h: number) => out.some((s) => s.start.hour === h)
      expect(has(10)).toBe(true) //  10:00..11:00 — fits before absence
      expect(has(11)).toBe(false) // 11:00..12:00 — entirely inside absence
      expect(has(12)).toBe(false) // 12:00..13:00 — ends right at absence end, but the start..end interval is inside
      expect(has(13)).toBe(true) //  13:00..14:00 — after absence
    })
  })

  describe("buffer-before", () => {
    it("skips early starts that would push needStart < 0", () => {
      // bufferBefore=30 means a 10:00 start needs the provider mask
      // free from 09:30. 09:30 is outside the bitmap range, so the
      // first usable start moves to ≥ 10:30 (granularity 30).
      const svc: Service = {
        ...baseService,
        bufferBeforeMinutes: minutesUnchecked(30),
      }
      const out = computeAvailableSlots(
        baseEnv({ servicesById: new Map([[SERVICE_ID, svc]]) }),
        baseQuery({ service: svc }),
      )
      // 10:00 start would need needStart = 10:00 - 30min = 09:30 → < 0 in
      // minute-of-day terms after the business-hours mask is built; the
      // candidate walk skips it. First valid start is 10:30.
      const first = out[0]
      if (!first) throw new Error("expected at least one slot")
      expect(first.start.hour).toBe(10)
      expect(first.start.minute).toBe(30)
    })
  })

  describe("walk-in / cancelled booking handling", () => {
    it("a cancelled booking does not occupy slots", () => {
      const cancelledOnA: Booking = {
        ...confirmedBooking({
          providerId: PROVIDER_ID_A,
          resourceIds: [RESOURCE_ID_1],
          slot: slot("2026-05-11T04:00:00Z", "2026-05-11T05:00:00Z"),
        }),
        state: "Cancelled",
        cancelledAt: Temporal.Instant.from("2026-05-09T13:00:00Z"),
        reason: "test",
        cancelledBy: "customer",
      }
      const out = computeAvailableSlots(baseEnv({ existingBookings: [cancelledOnA] }), baseQuery())
      const at13 = out.find((s) => s.start.hour === 13 && s.start.minute === 0)
      // Provider A should be available since the booking is cancelled — the
      // ID-asc tiebreak picks A.
      expect(at13?.providerId).toBe(PROVIDER_ID_A)
    })
  })
})

void newServiceId // keep import for future tests
