import { Temporal } from "@js-temporal/polyfill"
import type { Booking } from "../booking/Booking.js"
import type { BusinessHours } from "../entities/BusinessHours.js"
import type { Closure } from "../entities/Closure.js"
import { type Provider, providerSatisfies } from "../entities/Provider.js"
import type { ProviderAbsence } from "../entities/ProviderAbsence.js"
import type { Resource } from "../entities/Resource.js"
import type { Service } from "../entities/Service.js"
import type { Weekday } from "../entities/Weekday.js"
import type { ProviderId, ResourceId, ServiceId } from "../types/EntityId.js"
import type { BusinessTimeZone } from "../value-objects/BusinessTimeZone.js"
import type { ResourceType } from "../value-objects/ResourceType.js"
import { and, type Bitmap, clearRange, empty, full, isSet, setRange } from "./Bitmap.js"

/** Inputs for slot computation. All fields are read-only and pure data. */
export type SlotCalcInput = {
  readonly service: Service
  readonly date: Temporal.PlainDate
  readonly timeZone: BusinessTimeZone
  readonly businessHoursByWeekday: ReadonlyMap<Weekday, BusinessHours>
  readonly closures: readonly Closure[]
  readonly providers: readonly Provider[]
  readonly resources: readonly Resource[]
  readonly providerAbsences: readonly ProviderAbsence[]
  readonly servicesById: ReadonlyMap<ServiceId, Service>
  readonly existingBookings: readonly Booking[]
  readonly now: Temporal.Instant
  readonly slotGranularityMinutes: number
}

/** A single bookable slot derived from `computeAvailableSlots`. */
export type AvailableSlot = {
  readonly start: Temporal.ZonedDateTime
  readonly end: Temporal.ZonedDateTime
  readonly providerId: ProviderId
  readonly resourceIds: readonly ResourceId[]
}

const MINUTES_PER_DAY = 1_440

const isActiveBooking = (b: Booking): boolean => b.state === "Held" || b.state === "Confirmed"

const idAsc = <T extends { id: string }>(a: T, b: T): number =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0

/** Minute-of-day in a target day for an Instant. Negative if before, ≥1440 if after. */
const minuteOfTargetDay = (instant: Temporal.Instant, dayStart: Temporal.ZonedDateTime): number => {
  const ns = instant.epochNanoseconds - dayStart.toInstant().epochNanoseconds
  return Number(ns / 60_000_000_000n)
}

/** True iff `[start, end)` of `mask` is all set. */
const rangeAllSet = (mask: Bitmap, start: number, end: number): boolean => {
  if (start < 0 || end > mask.length || end <= start) return false
  for (let i = start; i < end; i++) if (!isSet(mask, i)) return false
  return true
}

/**
 * Pure, deterministic computation of bookable slots on a single day,
 * driven by ADR-0012 bitmap arithmetic. Same input → same output.
 *
 * Algorithm sketch:
 *   1. Drop the date if it falls in a Closure or has no business hours.
 *   2. Build a 1440-bit per-day mask: open windows ∧ ¬past.
 *   3. Per eligible Provider (skill match, enabled), AND the day mask
 *      with ¬absences ∧ ¬booking-occupancy(±buffer).
 *   4. Per eligible Resource (type match, enabled), AND the day mask
 *      with ¬booking-occupancy. Multi-day services that hold a Resource
 *      across the date clear the entire day's resource mask.
 *   5. Walk candidate starts at granularity. The first ID-ordered
 *      Provider with a free `[start - bufBefore, start + D + bufAfter)`
 *      pairs with the first Resource of each required type that has
 *      a free `[start, start + D)`. ID order makes the result
 *      deterministic.
 */
export const computeAvailableSlots = (input: SlotCalcInput): readonly AvailableSlot[] => {
  if (!input.service.enabled) return []
  if (input.slotGranularityMinutes <= 0) return []

  const weekday = input.date.dayOfWeek as Weekday
  const bh = input.businessHoursByWeekday.get(weekday)
  if (!bh || bh.windows.length === 0) return []

  if (input.closures.some((c) => c.date.equals(input.date))) return []

  const dayStart = input.date.toZonedDateTime({ timeZone: input.timeZone })

  // 1. Day mask: business hours ∧ ¬past minutes
  let dayMask = empty(MINUTES_PER_DAY)
  for (const w of bh.windows) {
    const startMin = w.start.hour * 60 + w.start.minute
    const endMin = w.end.hour * 60 + w.end.minute
    dayMask = setRange(dayMask, startMin, endMin)
  }

  let notPast = full(MINUTES_PER_DAY)
  const nowZdt = input.now.toZonedDateTimeISO(input.timeZone)
  const nowDate = nowZdt.toPlainDate()
  const cmpDate = Temporal.PlainDate.compare(input.date, nowDate)
  if (cmpDate < 0) return []
  if (cmpDate === 0) {
    const nowMin = nowZdt.hour * 60 + nowZdt.minute + 1
    notPast = clearRange(notPast, 0, Math.min(nowMin, MINUTES_PER_DAY))
  }
  const baseMask = and(dayMask, notPast)

  // 2. Eligible providers
  const eligibleProviders = input.providers
    .filter((p) => p.enabled && providerSatisfies(p, input.service.requiredSkills))
    .toSorted(idAsc)

  // 3. Per-provider availability mask
  const providerMasks = new Map<ProviderId, Bitmap>()
  for (const p of eligibleProviders) {
    let mask = baseMask
    for (const a of input.providerAbsences) {
      if (a.providerId !== p.id) continue
      const lo = Math.max(0, minuteOfTargetDay(a.start, dayStart))
      const hi = Math.min(MINUTES_PER_DAY, minuteOfTargetDay(a.end, dayStart))
      if (hi > lo) mask = clearRange(mask, lo, hi)
    }
    for (const b of input.existingBookings) {
      if (b.providerId !== p.id) continue
      if (!isActiveBooking(b)) continue
      const svc = input.servicesById.get(b.serviceId)
      const bufBefore = svc?.bufferBeforeMinutes ?? 0
      const bufAfter = svc?.bufferAfterMinutes ?? 0
      const lo = Math.max(0, minuteOfTargetDay(b.slot.start, dayStart) - bufBefore)
      const hi = Math.min(MINUTES_PER_DAY, minuteOfTargetDay(b.slot.end, dayStart) + bufAfter)
      if (hi > lo) mask = clearRange(mask, lo, hi)
    }
    providerMasks.set(p.id, mask)
  }

  // 4. Eligible resources by type
  const eligibleResources = input.resources
    .filter((r) => r.enabled && input.service.requiredResourceTypes.has(r.type))
    .toSorted(idAsc)

  const resourcesByType = new Map<ResourceType, Resource[]>()
  for (const r of eligibleResources) {
    const list = resourcesByType.get(r.type) ?? []
    list.push(r)
    resourcesByType.set(r.type, list)
  }

  // 5. Per-resource availability mask, including holding-period blackout
  const resourceMasks = new Map<ResourceId, Bitmap>()
  for (const r of eligibleResources) {
    let mask = baseMask
    for (const b of input.existingBookings) {
      if (!b.resourceIds.includes(r.id)) continue
      if (!isActiveBooking(b)) continue
      const svc = input.servicesById.get(b.serviceId)
      const holdingDays = svc?.holdingDays ?? 0
      const bufAfter = svc?.bufferAfterMinutes ?? 0
      const bookingDate = b.slot.start.toZonedDateTimeISO(input.timeZone).toPlainDate()
      const holdingEndDate = holdingDays > 0 ? bookingDate.add({ days: holdingDays }) : bookingDate

      const onOrAfterStart = Temporal.PlainDate.compare(input.date, bookingDate) >= 0
      const onOrBeforeEnd = Temporal.PlainDate.compare(input.date, holdingEndDate) <= 0
      if (!(onOrAfterStart && onOrBeforeEnd)) continue

      if (input.date.equals(bookingDate)) {
        const lo = Math.max(0, minuteOfTargetDay(b.slot.start, dayStart))
        const hi = Math.min(MINUTES_PER_DAY, minuteOfTargetDay(b.slot.end, dayStart) + bufAfter)
        if (hi > lo) mask = clearRange(mask, lo, hi)
      } else {
        // Hold day (between booking date + 1 and holding end): block the whole day.
        mask = empty(MINUTES_PER_DAY)
        break
      }
    }
    resourceMasks.set(r.id, mask)
  }

  // 6. Walk candidate starts, deterministically pair Provider × Resources
  const D = input.service.durationMinutes
  const bufBefore = input.service.bufferBeforeMinutes
  const bufAfter = input.service.bufferAfterMinutes
  const G = input.slotGranularityMinutes

  const out: AvailableSlot[] = []
  for (let startMin = 0; startMin + D <= MINUTES_PER_DAY; startMin += G) {
    const needStart = startMin - bufBefore
    const needEnd = startMin + D + bufAfter
    if (needStart < 0 || needEnd > MINUTES_PER_DAY) continue

    let provider: ProviderId | undefined
    for (const p of eligibleProviders) {
      const mask = providerMasks.get(p.id)
      if (!mask) continue
      if (rangeAllSet(mask, needStart, needEnd)) {
        provider = p.id
        break
      }
    }
    if (!provider) continue

    const chosenResources: ResourceId[] = []
    let allTypesMatched = true
    for (const requiredType of input.service.requiredResourceTypes) {
      const candidates = resourcesByType.get(requiredType) ?? []
      let pick: ResourceId | undefined
      for (const r of candidates) {
        if (chosenResources.includes(r.id)) continue
        const mask = resourceMasks.get(r.id)
        if (!mask) continue
        if (rangeAllSet(mask, startMin, startMin + D)) {
          pick = r.id
          break
        }
      }
      if (!pick) {
        allTypesMatched = false
        break
      }
      chosenResources.push(pick)
    }
    if (!allTypesMatched) continue

    out.push({
      start: dayStart.add({ minutes: startMin }),
      end: dayStart.add({ minutes: startMin + D }),
      providerId: provider,
      resourceIds: chosenResources,
    })
  }

  return out
}
