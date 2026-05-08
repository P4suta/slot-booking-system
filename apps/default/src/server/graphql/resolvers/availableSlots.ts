import {
  type BusinessTimeZone,
  computeAvailableSlots,
  type DomainError,
  errorToGraphQLPayload,
  ServiceCatalog,
  type ServiceCatalogOps,
  type SlotCalcEnv,
  type SlotCalcQuery,
  StorageError,
} from "@booking/core"
import { Temporal } from "@js-temporal/polyfill"
import { Effect, Schema } from "effect"
import {
  type GraphQLFieldConfig,
  GraphQLList,
  GraphQLNonNull,
  type GraphQLObjectType,
  GraphQLString,
} from "graphql"
import { makeD1ServiceCatalog } from "../../adapters/D1ServiceCatalogLive.js"
import { businessTimeZoneFromEnv, readWorldSnapshot } from "../../adapters/D1WorldSnapshot.js"
import { signSlot } from "../../auth/slotToken.js"
import type { GraphQLContext } from "../context.js"
import { schemaToGraphQLOutputType } from "../derive.js"
import { BookingError } from "../errors.js"
import { instantScalar, phoneLast4Scalar, plainDateScalar } from "../resolver.js"

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

/**
 * Wire shape for the `availableSlots` query. Brands on `start` /
 * `end` route through {@link schemaToGraphQLOutputType}'s scalar
 * registry to {@link instantScalar}; the rest reads as plain strings
 * (`token` is the opaque HMAC envelope, not a domain identifier).
 */
const AvailableSlotWireSchema = Schema.Struct({
  serviceId: Schema.String,
  start: Schema.String.pipe(Schema.brand("Instant")),
  end: Schema.String.pipe(Schema.brand("Instant")),
  providerId: Schema.String,
  resourceIds: Schema.Array(Schema.String),
  token: Schema.String,
})
// Encoded shape (post-decode brand stripped) — matches the runtime
// values produced by `slotsBody` (`Temporal.Instant.toString()` is a
// plain string until it's parsed back through `InstantSchema`).
type AvailableSlotShape = Schema.Codec.Encoded<typeof AvailableSlotWireSchema>

const availableSlotScalarRegistry = new Map([
  ["PlainDate", plainDateScalar],
  ["Instant", instantScalar],
  ["PhoneLast4", phoneLast4Scalar],
])

const availableSlotType = schemaToGraphQLOutputType(AvailableSlotWireSchema, {
  name: "AvailableSlot",
  description:
    "A bookable time interval with a tentative provider/resources assignment. The " +
    "`token` field is an HMAC-signed envelope over the slot fields; clients MUST " +
    "echo it back unchanged on `holdSlot` / `rescheduleBooking`. The mutation " +
    "resolver verifies the token before reaching the DO RPC, so a tampered slot " +
    "cannot bypass the world-consistency check that justifies the brand on " +
    "`AvailableSlot`.",
  scalarRegistry: availableSlotScalarRegistry,
}) as GraphQLObjectType

/**
 * Run a `world → slots` Effect through a fresh per-request catalog
 * Layer. Failures are mapped to the GraphQL `BookingError` arm via
 * the class-side metadata accessors `codeOf` / `severityOf`
 * (Phase 2.0 / BI-2 — no string-tag dispatch).
 */
const runQuery = async (
  env: GraphQLContext["env"],
  body: (cat: ServiceCatalogOps) => Effect.Effect<readonly AvailableSlotShape[], DomainError>,
): Promise<readonly AvailableSlotShape[]> => {
  const layer = makeD1ServiceCatalog(env.DB)
  const result = await Effect.runPromise(
    Effect.result(
      Effect.flatMap(Effect.service(ServiceCatalog), (cat) => body(cat)).pipe(
        Effect.provide(layer),
      ),
    ),
  )
  if (result._tag === "Success") return result.success
  throw new BookingError(errorToGraphQLPayload(result.failure))
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
        catch: (e) => new StorageError({ reason: "slot token signing failed", cause: e }),
      })
    },
  )

export const availableSlotsQueryFields = (): Record<
  string,
  GraphQLFieldConfig<unknown, GraphQLContext>
> => ({
  availableSlots: {
    type: new GraphQLList(new GraphQLNonNull(availableSlotType)),
    description:
      "Bookable slots for a service on a given date. Pure result of " +
      "`computeAvailableSlots(world, query)` against the catalog snapshot.",
    args: {
      serviceId: { type: new GraphQLNonNull(GraphQLString) },
      date: { type: new GraphQLNonNull(plainDateScalar) },
    },
    resolve: async (_root, args, ctx) => {
      const { serviceId, date } = args as { readonly serviceId: string; readonly date: string }
      const tz = businessTimeZoneFromEnv(ctx.env.DEPLOYMENT_TIMEZONE)
      if (tz._tag === "Failure") {
        throw new BookingError(errorToGraphQLPayload(tz.failure))
      }
      return runQuery(ctx.env, (cat) =>
        slotsBody(cat, ctx.env.DB, serviceId, date, tz.success, ctx.env.SLOT_HMAC_SECRET),
      )
    },
  },
})
