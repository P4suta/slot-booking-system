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
import * as B from "./Bitmap.js"

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

const idAsc = <T extends { readonly id: string }>(a: T, b: T): number => a.id.localeCompare(b.id)

/** Minute-of-day in a target day for an Instant. Negative if before, ≥1440 if after. */
const minuteOfTargetDay = (instant: Temporal.Instant, dayStart: Temporal.ZonedDateTime): number => {
  const ns = instant.epochNanoseconds - dayStart.toInstant().epochNanoseconds
  return Number(ns / 60_000_000_000n)
}

/**
 * True iff every bit in `[start, end)` of `mask` is set.
 *
 * Precondition: `0 <= start < end <= mask.length`. The candidate-walk
 * loop in `computeAvailableSlots` enforces this before invocation, so
 * no defensive guard is needed here.
 */
const rangeAllSet = (mask: B.Bitmap, start: number, end: number): boolean => {
  for (let i = start; i < end; i++) if (!B.isSet(mask, i)) return false
  return true
}

/** A provider paired with its precomputed daily availability mask. */
type ProviderAvailability = {
  readonly id: ProviderId
  readonly mask: B.Bitmap
}

/** A resource paired with its precomputed daily availability mask. */
type ResourceAvailability = {
  readonly id: ResourceId
  readonly type: ResourceType
  readonly mask: B.Bitmap
}

/**
 * A booking already resolved against the service map. Bookings whose
 * `serviceId` is unknown to the input are dropped at the boundary so
 * downstream code can rely on `service` being present.
 */
type ResolvedBooking = {
  readonly booking: Booking
  readonly service: Service
}

const resolveBookings = (
  bookings: readonly Booking[],
  servicesById: ReadonlyMap<ServiceId, Service>,
): readonly ResolvedBooking[] =>
  bookings.flatMap((booking) => {
    const service = servicesById.get(booking.serviceId)
    return service !== undefined ? [{ booking, service } as const] : []
  })

const buildBusinessAndPastMask = (
  bh: BusinessHours,
  date: Temporal.PlainDate,
  now: Temporal.Instant,
  timeZone: BusinessTimeZone,
): B.Bitmap | null => {
  let mask = B.empty(MINUTES_PER_DAY)
  for (const w of bh.windows) {
    const startMin = w.start.hour * 60 + w.start.minute
    const endMin = w.end.hour * 60 + w.end.minute
    mask = B.setRange(mask, startMin, endMin)
  }
  const nowZdt = now.toZonedDateTimeISO(timeZone)
  const cmpDate = Temporal.PlainDate.compare(date, nowZdt.toPlainDate())
  if (cmpDate < 0) return null
  if (cmpDate === 0) {
    const nowMin = nowZdt.hour * 60 + nowZdt.minute + 1
    mask = B.clearRange(mask, 0, Math.min(nowMin, MINUTES_PER_DAY))
  }
  return mask
}

const computeProviderAvailabilities = (
  baseMask: B.Bitmap,
  service: Service,
  providers: readonly Provider[],
  absences: readonly ProviderAbsence[],
  bookings: readonly ResolvedBooking[],
  dayStart: Temporal.ZonedDateTime,
): readonly ProviderAvailability[] =>
  providers
    .filter((p) => p.enabled && providerSatisfies(p, service.requiredSkills))
    .toSorted(idAsc)
    .map((p) => {
      const fromAbsences = absences
        .filter((a) => a.providerId === p.id)
        .reduce((mask, a) => {
          const lo = Math.max(0, minuteOfTargetDay(a.start, dayStart))
          const hi = Math.min(MINUTES_PER_DAY, minuteOfTargetDay(a.end, dayStart))
          return B.clearRange(mask, lo, hi)
        }, baseMask)
      const finalMask = bookings
        .filter(({ booking }) => booking.providerId === p.id && isActiveBooking(booking))
        .reduce((mask, { booking, service: svc }) => {
          const lo = Math.max(
            0,
            minuteOfTargetDay(booking.slot.start, dayStart) - svc.bufferBeforeMinutes,
          )
          const hi = Math.min(
            MINUTES_PER_DAY,
            minuteOfTargetDay(booking.slot.end, dayStart) + svc.bufferAfterMinutes,
          )
          return B.clearRange(mask, lo, hi)
        }, fromAbsences)
      return { id: p.id, mask: finalMask } as const
    })

/** Effect a booking has on a resource's availability for a given date. */
type ResourceImpact =
  | { readonly kind: "none" }
  | { readonly kind: "clear"; readonly lo: number; readonly hi: number }
  | { readonly kind: "blackout" }

const resourceImpact = (
  rb: ResolvedBooking,
  date: Temporal.PlainDate,
  dayStart: Temporal.ZonedDateTime,
  timeZone: BusinessTimeZone,
): ResourceImpact => {
  const { booking, service: svc } = rb
  if (!isActiveBooking(booking)) return { kind: "none" }
  const bookingDate = booking.slot.start.toZonedDateTimeISO(timeZone).toPlainDate()
  const holdingEndDate =
    svc.holdingDays > 0 ? bookingDate.add({ days: svc.holdingDays }) : bookingDate
  const cmpStart = Temporal.PlainDate.compare(date, bookingDate)
  const cmpEnd = Temporal.PlainDate.compare(date, holdingEndDate)
  if (cmpStart < 0 || cmpEnd > 0) return { kind: "none" }
  if (cmpStart > 0) return { kind: "blackout" }
  // Same calendar day as the booking — clear the work interval + bufAfter.
  const lo = Math.max(0, minuteOfTargetDay(booking.slot.start, dayStart))
  const hi = Math.min(
    MINUTES_PER_DAY,
    minuteOfTargetDay(booking.slot.end, dayStart) + svc.bufferAfterMinutes,
  )
  return { kind: "clear", lo, hi }
}

const computeResourceAvailabilities = (
  baseMask: B.Bitmap,
  service: Service,
  resources: readonly Resource[],
  bookings: readonly ResolvedBooking[],
  date: Temporal.PlainDate,
  dayStart: Temporal.ZonedDateTime,
  timeZone: BusinessTimeZone,
): readonly ResourceAvailability[] =>
  resources
    .filter((r) => r.enabled && service.requiredResourceTypes.has(r.type))
    .toSorted(idAsc)
    .map((r) => {
      const relevant = bookings.filter(({ booking }) => booking.resourceIds.includes(r.id))
      const impacts = relevant.map((rb) => resourceImpact(rb, date, dayStart, timeZone))
      if (impacts.some((i) => i.kind === "blackout")) {
        return { id: r.id, type: r.type, mask: B.empty(MINUTES_PER_DAY) } as const
      }
      const mask = impacts.reduce(
        (m, i) => (i.kind === "clear" ? B.clearRange(m, i.lo, i.hi) : m),
        baseMask,
      )
      return { id: r.id, type: r.type, mask } as const
    })

const pickProvider = (
  providers: readonly ProviderAvailability[],
  needStart: number,
  needEnd: number,
): ProviderId | undefined => {
  for (const { id, mask } of providers) {
    if (rangeAllSet(mask, needStart, needEnd)) return id
  }
  return undefined
}

const pickResources = (
  resourcesByType: ReadonlyMap<ResourceType, readonly ResourceAvailability[]>,
  requiredTypes: ReadonlySet<ResourceType>,
  startMin: number,
  endMin: number,
): readonly ResourceId[] | undefined => {
  const chosen: ResourceId[] = []
  for (const requiredType of requiredTypes) {
    const candidates = resourcesByType.get(requiredType) ?? []
    const pick = candidates.find(
      (r) => !chosen.includes(r.id) && rangeAllSet(r.mask, startMin, endMin),
    )
    if (!pick) return undefined
    chosen.push(pick.id)
  }
  return chosen
}

const groupByType = (
  list: readonly ResourceAvailability[],
): ReadonlyMap<ResourceType, readonly ResourceAvailability[]> => {
  const out = new Map<ResourceType, ResourceAvailability[]>()
  for (const r of list) {
    const acc = out.get(r.type) ?? []
    acc.push(r)
    out.set(r.type, acc)
  }
  return out
}

/**
 * Pure, deterministic computation of bookable slots on a single day,
 * driven by ADR-0012 bitmap arithmetic. Same input → same output.
 *
 * Algorithm:
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
  const baseMask = buildBusinessAndPastMask(bh, input.date, input.now, input.timeZone)
  if (baseMask === null) return []

  const resolved = resolveBookings(input.existingBookings, input.servicesById)

  const providerAvailabilities = computeProviderAvailabilities(
    baseMask,
    input.service,
    input.providers,
    input.providerAbsences,
    resolved,
    dayStart,
  )

  const resourceAvailabilities = computeResourceAvailabilities(
    baseMask,
    input.service,
    input.resources,
    resolved,
    input.date,
    dayStart,
    input.timeZone,
  )
  const resourcesByType = groupByType(resourceAvailabilities)

  const D = input.service.durationMinutes
  const bufBefore = input.service.bufferBeforeMinutes
  const bufAfter = input.service.bufferAfterMinutes
  const G = input.slotGranularityMinutes

  const out: AvailableSlot[] = []
  for (let startMin = 0; startMin + D <= MINUTES_PER_DAY; startMin += G) {
    const needStart = startMin - bufBefore
    const needEnd = startMin + D + bufAfter
    if (needStart < 0 || needEnd > MINUTES_PER_DAY) continue

    const provider = pickProvider(providerAvailabilities, needStart, needEnd)
    if (!provider) continue

    const resourceIds = pickResources(
      resourcesByType,
      input.service.requiredResourceTypes,
      startMin,
      startMin + D,
    )
    if (!resourceIds) continue

    out.push({
      start: dayStart.add({ minutes: startMin }),
      end: dayStart.add({ minutes: startMin + D }),
      providerId: provider,
      resourceIds,
    })
  }
  return out
}
