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
  baseInput,
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
    const out = computeAvailableSlots(baseInput())
    // 10:00..18:00 = 480 minutes; service = 60+15 buffer = 75; granularity 30
    // So starts at 10:00, 10:30, ..., 16:45 — actually since 17:00 + 15 = 17:15 ≤ 18:00,
    // last start where startMin + 60 + 15 ≤ 480+(start of day) … target is local 10:00..18:00.
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
    expect(computeAvailableSlots(baseInput({ closures: [closure] }))).toEqual([])
  })

  it("returns empty when business hours are missing for the weekday", () => {
    const monBh = bhAllWeekdays.get(weekday(1))
    if (!monBh) throw new Error("unreachable")
    const onlyMon = new Map([[weekday(1), monBh]])
    const sunday = date("2026-05-10") // Sunday
    expect(
      computeAvailableSlots(baseInput({ businessHoursByWeekday: onlyMon, date: sunday })),
    ).toEqual([])
  })

  it("returns empty when slot granularity is non-positive", () => {
    expect(computeAvailableSlots(baseInput({ slotGranularityMinutes: 0 }))).toEqual([])
    expect(computeAvailableSlots(baseInput({ slotGranularityMinutes: -5 }))).toEqual([])
  })

  it("returns empty when service is disabled", () => {
    const disabled: Service = { ...baseService, enabled: false }
    expect(
      computeAvailableSlots(
        baseInput({
          service: disabled,
          servicesById: new Map([[SERVICE_ID, disabled]]),
        }),
      ),
    ).toEqual([])
  })

  it("clears past minutes when the target date is today", () => {
    // Now = 2026-05-11 13:00 JST = 04:00 UTC, target date = 2026-05-11 JST.
    const now = Temporal.Instant.from("2026-05-11T04:00:00Z")
    const out = computeAvailableSlots(baseInput({ now }))
    for (const s of out) {
      expect(s.start.hour).toBeGreaterThanOrEqual(13)
    }
  })

  it("returns empty for a date entirely in the past", () => {
    const yesterday = date("2026-05-10")
    const now = Temporal.Instant.from("2026-05-11T04:00:00Z")
    // Sunday has BH in our default; clear it for past-date check
    expect(computeAvailableSlots(baseInput({ date: yesterday, now }))).toEqual([])
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
    const out = computeAvailableSlots(baseInput({ existingBookings: [occupied] }))
    // The 13:00 slot should still appear (provider B picks it up) but with provider B.
    const at13 = out.find((s) => s.start.hour === 13 && s.start.minute === 0)
    expect(at13?.providerId).toBe(PROVIDER_ID_B)
  })

  it("disappears slot when both providers are booked", () => {
    const t1 = slot("2026-05-11T04:00:00Z", "2026-05-11T05:00:00Z")
    const t2 = slot("2026-05-11T04:00:00Z", "2026-05-11T05:00:00Z")
    const out = computeAvailableSlots(
      baseInput({
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
    )
    const at13 = out.find((s) => s.start.hour === 13 && s.start.minute === 0)
    expect(at13).toBeUndefined()
  })

  it("respects required-resource-type — empty if no matching type", () => {
    const otherType = resourceType("storage")
    const out = computeAvailableSlots(
      baseInput({
        service: { ...baseService, requiredResourceTypes: new Set([otherType]) },
        servicesById: new Map([
          [SERVICE_ID, { ...baseService, requiredResourceTypes: new Set([otherType]) }],
        ]),
      }),
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
      baseInput({
        service: electricService,
        servicesById: new Map([[SERVICE_ID, electricService]]),
      }),
    )
    expect(out).toEqual([]) // no provider has the skill
  })

  it("is deterministic — same input twice yields the same output", () => {
    const i = baseInput()
    expect(JSON.stringify(computeAvailableSlots(i))).toBe(JSON.stringify(computeAvailableSlots(i)))
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
              baseInput({
                service: svc,
                servicesById: new Map([[SERVICE_ID, svc]]),
                slotGranularityMinutes: G,
              }),
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
        baseInput({
          service: svc,
          servicesById: new Map([[SERVICE_ID, svc]]),
          slotGranularityMinutes: 60,
        }),
      )
      // Group by provider; assert no overlapping pairs.
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
            const before = computeAvailableSlots(baseInput()).length
            const after = computeAvailableSlots(baseInput({ existingBookings: [occupied] })).length
            return after <= before
          },
        ),
        { numRuns: 50 },
      )
    })

    it("invariant 4: works at multiple granularities (count is non-zero for each)", () => {
      for (const G of [15, 30, 60]) {
        const out = computeAvailableSlots(baseInput({ slotGranularityMinutes: G }))
        expect(out.length).toBeGreaterThan(0)
      }
    })

    it("invariant 5: deterministic ordering — output sorted by start", () => {
      const out = computeAvailableSlots(baseInput())
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
        baseInput({
          service: { ...overhaulSvc, id: overhaulId },
          servicesById: new Map([
            [SERVICE_ID, overhaulSvc],
            [overhaulId, { ...overhaulSvc, id: overhaulId }],
          ]),
          existingBookings: [existing],
          // Asking for slots on 2026-05-11 (Mon) — within the holding window.
        }),
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
        baseInput({
          service: { ...oneDaySvc, id: overhaulId },
          servicesById: new Map([[overhaulId, { ...oneDaySvc, id: overhaulId }]]),
          existingBookings: [existing],
        }),
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
      const out = computeAvailableSlots(baseInput({ existingBookings: [orphanBooking] }))
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
        baseInput({
          service: noBufferSvc,
          servicesById: new Map([[SERVICE_ID, noBufferSvc]]),
          // Single provider so we observe the absence directly.
          providers: [providerA],
          providerAbsences: [absence],
          slotGranularityMinutes: 60,
        }),
      )
      const has = (h: number) => out.some((s) => s.start.hour === h)
      expect(has(10)).toBe(true) //  10:00..11:00 — fits before absence
      expect(has(11)).toBe(false) // 11:00..12:00 — entirely inside absence
      expect(has(12)).toBe(false) // 12:00..13:00 — ends right at absence end, but the start..end interval is inside
      expect(has(13)).toBe(true) //  13:00..14:00 — after absence
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
      const out = computeAvailableSlots(baseInput({ existingBookings: [cancelledOnA] }))
      const at13 = out.find((s) => s.start.hour === 13 && s.start.minute === 0)
      // Provider A should be available since the booking is cancelled — the
      // ID-asc tiebreak picks A.
      expect(at13?.providerId).toBe(PROVIDER_ID_A)
    })
  })
})

void newServiceId // keep import for future tests
