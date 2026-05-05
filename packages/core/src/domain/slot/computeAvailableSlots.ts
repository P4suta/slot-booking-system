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

/**
 * Deployment-scoped, request-independent inputs to slot computation.
 * Cacheable across many `computeAvailableSlots(env, query)` calls within
 * a single HTTP request batch.
 */
export type SlotCalcEnv = {
  readonly timeZone: BusinessTimeZone
  readonly businessHoursByWeekday: ReadonlyMap<Weekday, BusinessHours>
  readonly closures: readonly Closure[]
  readonly providers: readonly Provider[]
  readonly resources: readonly Resource[]
  readonly providerAbsences: readonly ProviderAbsence[]
  readonly servicesById: ReadonlyMap<ServiceId, Service>
  readonly existingBookings: readonly Booking[]
  readonly slotGranularityMinutes: number
}

/** Per-call query against a {@link SlotCalcEnv}. */
export type SlotCalcQuery = {
  readonly service: Service
  readonly date: Temporal.PlainDate
  readonly now: Temporal.Instant
}

/** A single bookable slot derived from `computeAvailableSlots`. */
export type AvailableSlot = {
  readonly serviceId: ServiceId
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
 * A provider paired with the set of `start` offsets at which a window
 * of `[start, start + providerSpan)` is entirely free in that provider's
 * mask. `providerSpan = D + bufBefore + bufAfter`.
 */
type ProviderAvailability = {
  readonly id: ProviderId
  readonly runStarts: ReadonlySet<number>
}

/**
 * A resource paired with the set of `start` offsets at which a window
 * of `[start, start + D)` is entirely free in that resource's mask.
 */
type ResourceAvailability = {
  readonly id: ResourceId
  readonly type: ResourceType
  readonly runStarts: ReadonlySet<number>
}

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
  providerSpan: number,
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
      return { id: p.id, runStarts: new Set(B.findRunsOfLength(finalMask, providerSpan)) } as const
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
  duration: number,
): readonly ResourceAvailability[] =>
  resources
    .filter((r) => r.enabled && service.requiredResourceTypes.has(r.type))
    .toSorted(idAsc)
    .map((r) => {
      const relevant = bookings.filter(({ booking }) => booking.resourceIds.includes(r.id))
      const impacts = relevant.map((rb) => resourceImpact(rb, date, dayStart, timeZone))
      const mask = impacts.some((i) => i.kind === "blackout")
        ? B.empty(MINUTES_PER_DAY)
        : impacts.reduce((m, i) => (i.kind === "clear" ? B.clearRange(m, i.lo, i.hi) : m), baseMask)
      return {
        id: r.id,
        type: r.type,
        runStarts: new Set(B.findRunsOfLength(mask, duration)),
      } as const
    })

const pickProvider = (
  providers: readonly ProviderAvailability[],
  needStart: number,
): ProviderId | undefined => {
  for (const { id, runStarts } of providers) {
    if (runStarts.has(needStart)) return id
  }
  return undefined
}

const pickResources = (
  resourcesByType: ReadonlyMap<ResourceType, readonly ResourceAvailability[]>,
  requiredTypes: ReadonlySet<ResourceType>,
  startMin: number,
): readonly ResourceId[] | undefined => {
  const chosen: ResourceId[] = []
  for (const requiredType of requiredTypes) {
    const candidates = resourcesByType.get(requiredType) ?? []
    const pick = candidates.find((r) => !chosen.includes(r.id) && r.runStarts.has(startMin))
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
 *      with ¬absences ∧ ¬booking-occupancy(±buffer); precompute the
 *      set of `start` offsets where `[start, start + D + bufBefore +
 *      bufAfter)` is entirely free, via `Bitmap.findRunsOfLength`
 *      (O(span) bigint AND-shifts).
 *   4. Per eligible Resource (type match, enabled), AND the day mask
 *      with ¬booking-occupancy. Multi-day services that hold a Resource
 *      across the date clear the entire day's resource mask. Precompute
 *      the set of `start` offsets where `[start, start + D)` is free.
 *   5. Walk candidate starts at granularity. Membership lookup in the
 *      precomputed sets is O(1); the first ID-ordered Provider whose
 *      run set contains `start - bufBefore` pairs with the first
 *      Resource of each required type whose run set contains `start`.
 *      ID order makes the result deterministic; greedy first-match
 *      keeps the same world snapshot returning the same slot list,
 *      which is what the customer-facing self-service flow needs
 *      (ADR-0034 covers the rationale for greedy over bipartite
 *      matching).
 */
export const computeAvailableSlots = (
  env: SlotCalcEnv,
  query: SlotCalcQuery,
): readonly AvailableSlot[] => {
  if (!query.service.enabled) return []
  if (env.slotGranularityMinutes <= 0) return []

  const weekday = query.date.dayOfWeek as Weekday
  const bh = env.businessHoursByWeekday.get(weekday)
  if (!bh || bh.windows.length === 0) return []
  if (env.closures.some((c) => c.date.equals(query.date))) return []

  const dayStart = query.date.toZonedDateTime({ timeZone: env.timeZone })
  const baseMask = buildBusinessAndPastMask(bh, query.date, query.now, env.timeZone)
  if (baseMask === null) return []

  const resolved = resolveBookings(env.existingBookings, env.servicesById)

  const D = query.service.durationMinutes
  const bufBefore = query.service.bufferBeforeMinutes
  const bufAfter = query.service.bufferAfterMinutes
  const G = env.slotGranularityMinutes
  const providerSpan = D + bufBefore + bufAfter

  const providerAvailabilities = computeProviderAvailabilities(
    baseMask,
    query.service,
    env.providers,
    env.providerAbsences,
    resolved,
    dayStart,
    providerSpan,
  )

  const resourceAvailabilities = computeResourceAvailabilities(
    baseMask,
    query.service,
    env.resources,
    resolved,
    query.date,
    dayStart,
    env.timeZone,
    D,
  )
  const resourcesByType = groupByType(resourceAvailabilities)

  const out: AvailableSlot[] = []
  for (let startMin = 0; startMin + D <= MINUTES_PER_DAY; startMin += G) {
    const needStart = startMin - bufBefore
    if (needStart < 0) continue

    const provider = pickProvider(providerAvailabilities, needStart)
    if (!provider) continue

    const resourceIds = pickResources(
      resourcesByType,
      query.service.requiredResourceTypes,
      startMin,
    )
    if (!resourceIds) continue

    out.push({
      serviceId: query.service.id,
      start: dayStart.add({ minutes: startMin }),
      end: dayStart.add({ minutes: startMin + D }),
      providerId: provider,
      resourceIds,
    })
  }
  return out
}
