import {
  type BusinessTimeZone,
  computeAvailableSlots,
  type DomainError,
  ServiceCatalog,
  type ServiceCatalogOps,
  type SlotCalcEnv,
  type SlotCalcQuery,
  StorageError,
} from "@booking/core"
import { Temporal } from "@js-temporal/polyfill"
import { Effect } from "effect"
import { makeD1ServiceCatalog } from "../../adapters/D1ServiceCatalogLive.js"
import { businessTimeZoneFromEnv, readWorldSnapshot } from "../../adapters/D1WorldSnapshot.js"
import { signSlot } from "../../auth/slotToken.js"
import { builder, type GraphQLContext } from "../builder.js"
import { BookingError } from "../errors.js"

/**
 * `availableSlots` query — Phase 0.9 wires
 * `computeAvailableSlots(world, query)` end-to-end. The resolver:
 *
 *   1. Reads the deployment's `BusinessTimeZone` from `DEPLOYMENT_TIMEZONE`.
 *   2. Builds a fresh per-request `ServiceCatalog` over `env.DB`.
 *   3. Reads the world snapshot via {@link readWorldSnapshot} (six
 *      catalog `list()` calls + one bookings query, in parallel).
 *   4. Looks up the requested `Service` in the world map; rejects an
 *      unknown id with a typed `BookingError`.
 *   5. Calls the pure `computeAvailableSlots(env, query)` and emits
 *      the encoded shape that GraphQL serialises.
 *
 * The slot computation is pure; every side-effecting boundary is one
 * port call away. The resolver itself owns no business logic — it is
 * the thinnest possible adapter.
 */

// Default slot granularity — half-hour grid is the deployment-level
// trade-off between UX (fewer rounded slots) and search width (more
// candidates per booking attempt). Plumbed through here rather than
// hard-coded inside the slot-search module so deployments override
// without touching the core.
const DEFAULT_SLOT_GRANULARITY_MINUTES = 30

type AvailableSlotShape = {
  readonly serviceId: string
  readonly start: string
  readonly end: string
  readonly providerId: string
  readonly resourceIds: readonly string[]
  readonly token: string
}

const AvailableSlotType = builder.objectRef<AvailableSlotShape>("AvailableSlot").implement({
  description:
    "A bookable time interval with a tentative provider/resources assignment. The " +
    "`token` field is an HMAC-signed envelope over the slot fields; clients MUST " +
    "echo it back unchanged on `holdSlot` / `rescheduleBooking`. The mutation " +
    "resolver verifies the token before reaching the DO RPC, so a tampered slot " +
    "cannot bypass the world-consistency check that justifies the brand on " +
    "`AvailableSlot`.",
  fields: (t) => ({
    serviceId: t.exposeString("serviceId"),
    start: t.field({ type: "Instant", resolve: (s) => s.start }),
    end: t.field({ type: "Instant", resolve: (s) => s.end }),
    providerId: t.exposeString("providerId"),
    resourceIds: t.exposeStringList("resourceIds"),
    token: t.exposeString("token"),
  }),
})

const errorCodeOf = (e: DomainError): string => (e as { code?: string }).code ?? "E_INF_STORAGE"

const severityFromTag = (tag: string): "infrastructure" | "domain" | "validation" => {
  if (tag === "Storage" || tag === "Concurrency" || tag === "AggregateNotFound")
    return "infrastructure"
  if (tag.startsWith("Invalid") || tag === "MissingStaffCapability") return "validation"
  return "domain"
}

/**
 * Run a `world → slots` Effect through a fresh per-request catalog
 * Layer. Failures are mapped to the GraphQL `BookingError` arm.
 */
const runQuery = async (
  env: GraphQLContext["env"],
  body: (cat: ServiceCatalogOps) => Effect.Effect<readonly AvailableSlotShape[], DomainError>,
): Promise<readonly AvailableSlotShape[]> => {
  const layer = makeD1ServiceCatalog(env.DB)
  const result = await Effect.runPromise(
    Effect.either(Effect.flatMap(ServiceCatalog, (cat) => body(cat)).pipe(Effect.provide(layer))),
  )
  if (result._tag === "Right") return result.right
  throw new BookingError({
    _tag: result.left._tag,
    code: errorCodeOf(result.left),
    severity: severityFromTag(result.left._tag),
  })
}

const slotsBody = (
  catalog: ServiceCatalogOps,
  database: D1Database,
  serviceId: string,
  date: string,
  timeZone: BusinessTimeZone,
  hmacSecret: string,
): Effect.Effect<readonly AvailableSlotShape[], StorageError> =>
  Effect.flatMap(
    readWorldSnapshot(catalog, database, Temporal.PlainDate.from(date), {
      timeZone,
      slotGranularityMinutes: DEFAULT_SLOT_GRANULARITY_MINUTES,
    }),
    (world: SlotCalcEnv) => {
      const service = world.servicesById.get(serviceId as never)
      if (!service) {
        return Effect.fail(new StorageError({ reason: `unknown service: ${serviceId}` }))
      }
      const query: SlotCalcQuery = {
        service,
        date: Temporal.PlainDate.from(date),
        now: Temporal.Now.instant(),
      }
      const slots = computeAvailableSlots(world, query)
      return Effect.tryPromise({
        try: async () =>
          Promise.all(
            slots.map(async (s): Promise<AvailableSlotShape> => {
              const token = await signSlot(hmacSecret, s)
              return {
                serviceId: s.serviceId,
                start: s.start.toInstant().toString(),
                end: s.end.toInstant().toString(),
                providerId: s.providerId,
                resourceIds: s.resourceIds,
                token,
              }
            }),
          ),
        catch: (e) => new StorageError({ reason: "slot token signing failed", meta: { cause: e } }),
      })
    },
  )

builder.queryFields((t) => ({
  availableSlots: t.field({
    type: [AvailableSlotType],
    description:
      "Bookable slots for a service on a given date. Pure result of " +
      "`computeAvailableSlots(world, query)` against the catalog snapshot.",
    args: {
      serviceId: t.arg.string({ required: true }),
      date: t.arg({ type: "PlainDate", required: true }),
    },
    resolve: async (_root, args, ctx) => {
      const tz = businessTimeZoneFromEnv(ctx.env.DEPLOYMENT_TIMEZONE)
      if (tz._tag === "Left") {
        throw new BookingError({
          _tag: "Storage",
          code: "E_INF_STORAGE",
          severity: "infrastructure",
        })
      }
      return runQuery(ctx.env, (cat) =>
        slotsBody(cat, ctx.env.DB, args.serviceId, args.date, tz.right, ctx.env.SLOT_HMAC_SECRET),
      )
    },
  }),
}))
