import { Temporal } from "@js-temporal/polyfill"
import type { Brand } from "effect"
import { type Booking, isActive } from "../booking/Booking.js"
import type { BusinessHours } from "../entities/BusinessHours.js"
import type { Closure } from "../entities/Closure.js"
import { type Provider, providerIdentifiable, providerSatisfies } from "../entities/Provider.js"
import type { ProviderAbsence } from "../entities/ProviderAbsence.js"
import { type Resource, resourceIdentifiable, resourceTypeSatisfier } from "../entities/Resource.js"
import type { Service } from "../entities/Service.js"
import type { Weekday } from "../entities/Weekday.js"
import * as Identifiable from "../typeclass/Identifiable.js"
import type { ProviderId, ResourceId, ServiceId } from "../types/EntityId.js"
import { MINUTES_PER_DAY } from "../types/Temporal.js"
import type { BusinessTimeZone } from "../value-objects/BusinessTimeZone.js"
import type { ResourceType } from "../value-objects/ResourceType.js"
import * as B from "./Bitmap.js"
import { type Adjacency, matchBipartite } from "./bipartite.js"

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

/**
 * Structural shape of a bookable slot. Public for adapters that need
 * to work with the field set without committing to the brand (e.g.
 * GraphQL type definitions). Production callers should use
 * {@link AvailableSlot} so the value carries the world-consistency
 * proof from {@link computeAvailableSlots}.
 */
export type AvailableSlotShape = {
  readonly serviceId: ServiceId
  readonly start: Temporal.ZonedDateTime
  readonly end: Temporal.ZonedDateTime
  readonly providerId: ProviderId
  readonly resourceIds: readonly ResourceId[]
}

/**
 * A bookable slot returned by {@link computeAvailableSlots}. The
 * brand prevents callers from synthesising a slot value and feeding
 * it into write-side use cases (`HoldSlot` / `RescheduleBooking`)
 * without going through {@link mintAvailableSlot} — Phase 0.7-α5
 * groundwork for the HMAC-signed token round-trip in Phase 0.10.
 */
export type AvailableSlot = AvailableSlotShape & Brand.Brand<"AvailableSlot">

/**
 * Mint a branded {@link AvailableSlot} from a structural shape. The
 * production call site is {@link computeAvailableSlots} itself; this
 * helper is exposed for fixtures and the GraphQL adapter that
 * reconstructs a slot from a previously-emitted query result. The
 * world-consistency check that justifies the brand happens in those
 * code paths, not here.
 */
export const mintAvailableSlot = (shape: AvailableSlotShape): AvailableSlot =>
  shape as AvailableSlot

const providerIdAsc = Identifiable.toOrder(providerIdentifiable)
const resourceIdAsc = Identifiable.toOrder(resourceIdentifiable)

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
    .toSorted(providerIdAsc)
    .map((p) => {
      const fromAbsences = absences
        .filter((a) => a.providerId === p.id)
        .reduce((mask, a) => {
          const lo = Math.max(0, minuteOfTargetDay(a.start, dayStart))
          const hi = Math.min(MINUTES_PER_DAY, minuteOfTargetDay(a.end, dayStart))
          return B.clearRange(mask, lo, hi)
        }, baseMask)
      const finalMask = bookings
        .filter(({ booking }) => booking.providerId === p.id && isActive(booking))
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
  if (!isActive(booking)) return { kind: "none" }
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
    .filter((r) => r.enabled && resourceTypeSatisfier.satisfies(r, service.requiredResourceTypes))
    .toSorted(resourceIdAsc)
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

/**
 * Match the service's required resource types to concrete resource
 * instances via a bipartite maximum-cardinality matching (ADR-0040).
 * Left nodes are the requirement slots in the order
 * `requiredTypes.values()` produces them; right nodes are every
 * `(type, resource)` candidate available at `startMin` in ID-ascending
 * order. An edge connects requirement L to candidate R when
 * `candidates[R].type === requiredTypes[L]`. A perfect matching of
 * size `requiredTypes.size` is the witness that the slot is
 * feasible; anything less means at least one type cannot be filled
 * without double-assigning a resource, and the slot is dropped.
 *
 * The previous greedy first-match (ADR-0034) was correct for the
 * single-type-per-resource model. The matching primitive subsumes
 * it deterministically (left-first, right-input-order augmentation)
 * and gives the codebase a ready-made algorithm for the next time a
 * resource gains multiple type tags or weighted preferences.
 */
const pickResources = (
  resourcesByType: ReadonlyMap<ResourceType, readonly ResourceAvailability[]>,
  requiredTypes: ReadonlySet<ResourceType>,
  startMin: number,
): readonly ResourceId[] | undefined => {
  const types = [...requiredTypes]
  const candidates: readonly { readonly id: ResourceId; readonly type: ResourceType }[] = types
    .flatMap((t) => resourcesByType.get(t) ?? [])
    .filter((r) => r.runStarts.has(startMin))
    .map(({ id, type }) => ({ id, type }))
  if (candidates.length === 0 && types.length > 0) return undefined
  const adj: Adjacency = types.map((t) =>
    candidates.map((c, idx) => (c.type === t ? idx : -1)).filter((idx): idx is number => idx >= 0),
  )
  const { assignment, cardinality } = matchBipartite(adj, candidates.length)
  if (cardinality !== types.length) return undefined
  const out: ResourceId[] = []
  for (const r of assignment) {
    if (r === null) return undefined
    const c = candidates[r]
    if (c === undefined) return undefined
    out.push(c.id)
  }
  return out
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

    out.push(
      mintAvailableSlot({
        serviceId: query.service.id,
        start: dayStart.add({ minutes: startMin }),
        end: dayStart.add({ minutes: startMin + D }),
        providerId: provider,
        resourceIds,
      }),
    )
  }
  return out
}
