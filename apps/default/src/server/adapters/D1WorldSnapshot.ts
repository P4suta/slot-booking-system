import {
  BookingFromRow,
  type BusinessTimeZone,
  parseBusinessTimeZone,
  type Service,
  type ServiceCatalogOps,
  type SlotCalcEnv,
  StorageError,
} from "@booking/core"
import type { Temporal } from "@js-temporal/polyfill"
import { and, gte, lt } from "drizzle-orm"
import { drizzle } from "drizzle-orm/d1"
import { Effect, Either, Schema } from "effect"
import { bookings } from "../schema/index.js"

/**
 * Build a {@link SlotCalcEnv} for `computeAvailableSlots`. The
 * **catalog** rows come through the {@link ServiceCatalogOps} port —
 * `services` / `providers` / `resources` / `business_hours` /
 * `closures` / `provider_absences`, six `list()` calls run in parallel
 * inside Effect.all. The **bookings** rows come straight off D1 via
 * Drizzle, scoped to those that touch the requested civil date.
 *
 * Date scoping — `slot_start < dayEnd && slot_end >= dayStart`. Both
 * sides are converted to UTC instants via the deployment's
 * `timeZone`, so DST and zone-offset edges land on the right side of
 * the comparator. The encoded form (ISO-8601 Z) sorts lexicographically
 * the same as the instant ordering, so SQLite text comparison is
 * total without a second pass.
 *
 * Failure modes: any port-side error (catalog or bookings) lifts as
 * `StorageError`; the resolver maps that to `BookingError("Storage")`.
 */

const decodeBookingRow = Schema.decodeUnknownEither(BookingFromRow)

const dayBoundsUtc = (
  date: Temporal.PlainDate,
  timeZone: BusinessTimeZone,
): { readonly startIso: string; readonly endIso: string } => {
  const startZdt = date.toZonedDateTime({ timeZone })
  const endZdt = startZdt.add({ days: 1 })
  return {
    startIso: startZdt.toInstant().toString(),
    endIso: endZdt.toInstant().toString(),
  }
}

/**
 * Read every catalog list + the day's bookings in one batch and
 * assemble the {@link SlotCalcEnv} that `computeAvailableSlots`
 * consumes. The function is generic in `SlotCalcEnv` only — no
 * partial-overrides — so callers either have a complete world view
 * or an explicit failure.
 */
export const readWorldSnapshot = (
  catalog: ServiceCatalogOps,
  database: D1Database,
  date: Temporal.PlainDate,
  options: {
    readonly timeZone: BusinessTimeZone
    readonly slotGranularityMinutes: number
  },
): Effect.Effect<SlotCalcEnv, StorageError> => {
  const db = drizzle(database)
  const { startIso, endIso } = dayBoundsUtc(date, options.timeZone)

  const loadBookings = Effect.tryPromise({
    try: async () => {
      const rows = await db
        .select()
        .from(bookings)
        .where(and(gte(bookings.slotEnd, startIso), lt(bookings.slotStart, endIso)))
        .all()
      // The mirror table can carry rows whose PII has been purged
      // (NULL `name_kana` etc.) — those rows are not legitimate
      // domain bookings and `BookingFromRow` rejects them. The slot
      // search ignores them silently; an audit row in `audit_log`
      // is the operator-facing trail of the purge.
      return rows.flatMap((row) => {
        const decoded = decodeBookingRow(row)
        return decoded._tag === "Right" ? [decoded.right] : []
      })
    },
    catch: (e) => new StorageError({ reason: "D1 world bookings", meta: { cause: e } }),
  })

  return Effect.all(
    {
      services: catalog.services.list(),
      providers: catalog.providers.list(),
      resources: catalog.resources.list(),
      businessHoursList: catalog.businessHours.list(),
      closures: catalog.closures.list(),
      providerAbsences: catalog.providerAbsences.list(),
      existingBookings: loadBookings,
    },
    { concurrency: "unbounded" },
  ).pipe(
    Effect.map((parts): SlotCalcEnv => {
      const servicesById = new Map<Service["id"], Service>(parts.services.map((s) => [s.id, s]))
      const businessHoursByWeekday = new Map(parts.businessHoursList.map((bh) => [bh.weekday, bh]))
      return {
        timeZone: options.timeZone,
        businessHoursByWeekday,
        closures: parts.closures,
        providers: parts.providers,
        resources: parts.resources,
        providerAbsences: parts.providerAbsences,
        servicesById,
        existingBookings: parts.existingBookings,
        slotGranularityMinutes: options.slotGranularityMinutes,
      }
    }),
  )
}

/**
 * Lift the deployment's raw `DEPLOYMENT_TIMEZONE` env var into a
 * branded `BusinessTimeZone`. Folded onto `StorageError` so the
 * resolver can surface it through the existing failure channel; in
 * practice the misconfiguration is caught at deploy time, not at
 * request time.
 */
export const businessTimeZoneFromEnv = (
  raw: string,
): Either.Either<BusinessTimeZone, StorageError> =>
  Either.mapLeft(
    parseBusinessTimeZone(raw),
    () => new StorageError({ reason: `invalid DEPLOYMENT_TIMEZONE: ${raw}` }),
  )
