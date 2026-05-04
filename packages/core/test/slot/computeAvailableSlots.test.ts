import { Temporal } from "@js-temporal/polyfill"
import { Either } from "effect"
import * as fc from "fast-check"
import { describe, expect, it } from "vitest"
import type { Booking, Confirmed } from "../../src/domain/booking/Booking.js"
import { makeBusinessHours } from "../../src/domain/entities/BusinessHours.js"
import type { Closure } from "../../src/domain/entities/Closure.js"
import { makeOpenWindow } from "../../src/domain/entities/OpenWindow.js"
import type { Provider } from "../../src/domain/entities/Provider.js"
import type { Resource } from "../../src/domain/entities/Resource.js"
import type { Service } from "../../src/domain/entities/Service.js"
import { parseWeekday, type Weekday } from "../../src/domain/entities/Weekday.js"
import {
  type AvailableSlot,
  computeAvailableSlots,
  type SlotCalcInput,
} from "../../src/domain/slot/computeAvailableSlots.js"
import {
  type BusinessHoursId,
  type ClosureId,
  newBookingId,
  newServiceId,
  type ProviderId,
  type ResourceId,
  type ServiceId,
} from "../../src/domain/types/EntityId.js"
import { encodeBookingCode } from "../../src/domain/value-objects/BookingCode.js"
import { parseBusinessTimeZone } from "../../src/domain/value-objects/BusinessTimeZone.js"
import { minutesUnchecked } from "../../src/domain/value-objects/Duration.js"
import { parseFreeText } from "../../src/domain/value-objects/FreeText.js"
import { parseHoldingDays } from "../../src/domain/value-objects/HoldingDays.js"
import { parseNameKana } from "../../src/domain/value-objects/NameKana.js"
import { parsePhoneLast4 } from "../../src/domain/value-objects/PhoneLast4.js"
import { parseResourceType } from "../../src/domain/value-objects/ResourceType.js"
import { parseSkill } from "../../src/domain/value-objects/Skill.js"
import { makeTimeSlot, type TimeSlot } from "../../src/domain/value-objects/TimeSlot.js"

const tz = Either.getOrThrow(parseBusinessTimeZone("Asia/Tokyo"))
const skillGen = Either.getOrThrow(parseSkill("general"))
const typeWorkspace = Either.getOrThrow(parseResourceType("workspace"))
const wd = (n: number): Weekday => Either.getOrThrow(parseWeekday(n))
const t = (h: number, m = 0) => Temporal.PlainTime.from({ hour: h, minute: m })
const win = (a: number, b: number) => Either.getOrThrow(makeOpenWindow(t(a), t(b)))
const date = (s: string) => Temporal.PlainDate.from(s)

const SERVICE_ID = "serv_default" as ServiceId
const PROVIDER_ID_A = "prov_aaa" as ProviderId
const PROVIDER_ID_B = "prov_bbb" as ProviderId
const RESOURCE_ID_1 = "rsrc_111" as ResourceId
const RESOURCE_ID_2 = "rsrc_222" as ResourceId

const baseService: Service = {
  id: SERVICE_ID,
  name: "Test Service",
  description: "",
  durationMinutes: minutesUnchecked(60),
  bufferBeforeMinutes: minutesUnchecked(0),
  bufferAfterMinutes: minutesUnchecked(15),
  holdingDays: Either.getOrThrow(parseHoldingDays(0)),
  requiredSkills: new Set([skillGen]),
  requiredResourceTypes: new Set([typeWorkspace]),
  enabled: true,
}

const providerA: Provider = {
  id: PROVIDER_ID_A,
  name: "A",
  skills: new Set([skillGen]),
  enabled: true,
}
const providerB: Provider = {
  id: PROVIDER_ID_B,
  name: "B",
  skills: new Set([skillGen]),
  enabled: true,
}

const resource1: Resource = {
  id: RESOURCE_ID_1,
  name: "ws-1",
  type: typeWorkspace,
  enabled: true,
}
const resource2: Resource = {
  id: RESOURCE_ID_2,
  name: "ws-2",
  type: typeWorkspace,
  enabled: true,
}

const bhAllWeekdays = new Map([
  [wd(1), makeBusinessHours("bhrs_mon" as BusinessHoursId, wd(1), [win(10, 18)])],
  [wd(2), makeBusinessHours("bhrs_tue" as BusinessHoursId, wd(2), [win(10, 18)])],
  [wd(3), makeBusinessHours("bhrs_wed" as BusinessHoursId, wd(3), [win(10, 18)])],
  [wd(4), makeBusinessHours("bhrs_thu" as BusinessHoursId, wd(4), [win(10, 18)])],
  [wd(5), makeBusinessHours("bhrs_fri" as BusinessHoursId, wd(5), [win(10, 18)])],
  [wd(6), makeBusinessHours("bhrs_sat" as BusinessHoursId, wd(6), [win(10, 18)])],
  [wd(7), makeBusinessHours("bhrs_sun" as BusinessHoursId, wd(7), [win(10, 18)])],
])

const baseInput = (overrides: Partial<SlotCalcInput> = {}): SlotCalcInput => {
  const targetDate = date("2026-05-11") // Monday
  // "now" is well before the day so no past-cutoff
  const now = Temporal.Instant.from("2026-05-10T00:00:00Z")
  return {
    service: baseService,
    date: targetDate,
    timeZone: tz,
    businessHoursByWeekday: bhAllWeekdays,
    closures: [],
    providers: [providerA, providerB],
    resources: [resource1, resource2],
    providerAbsences: [],
    servicesById: new Map([[SERVICE_ID, baseService]]),
    existingBookings: [],
    now,
    slotGranularityMinutes: 30,
    ...overrides,
  }
}

const slot = (a: string, b: string) =>
  Either.getOrThrow(makeTimeSlot(Temporal.Instant.from(a), Temporal.Instant.from(b)))

const confirmedBooking = (params: {
  providerId: ProviderId
  resourceIds: readonly ResourceId[]
  slot: TimeSlot
}): Confirmed => ({
  id: newBookingId(),
  code: Either.getOrThrow(encodeBookingCode(0n)),
  serviceId: SERVICE_ID,
  providerId: params.providerId,
  resourceIds: params.resourceIds,
  slot: params.slot,
  source: "online",
  nameKana: Either.getOrThrow(parseNameKana("ヤマダ タロウ")),
  phoneLast4: Either.getOrThrow(parsePhoneLast4("1234")),
  freeText: Either.getOrThrow(parseFreeText("")),
  state: "Confirmed",
  confirmedAt: Temporal.Instant.from("2026-05-09T12:00:00Z"),
})

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
    const monBh = bhAllWeekdays.get(wd(1))
    if (!monBh) throw new Error("unreachable")
    const onlyMon = new Map([[wd(1), monBh]])
    const sunday = date("2026-05-10") // Sunday
    expect(
      computeAvailableSlots(baseInput({ businessHoursByWeekday: onlyMon, date: sunday })),
    ).toEqual([])
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
    const otherType = Either.getOrThrow(parseResourceType("storage"))
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
    const electric = Either.getOrThrow(parseSkill("electric_assist"))
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
