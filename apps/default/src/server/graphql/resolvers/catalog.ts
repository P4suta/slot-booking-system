import {
  BusinessHoursFromRow,
  ClosureFromRow,
  errorToI18nKey,
  ProviderAbsenceFromRow,
  ProviderFromRow,
  ResourceFromRow,
  ServiceCatalog,
  type ServiceCatalogOps,
  ServiceFromRow,
  type StorageError,
} from "@booking/core"
import { Effect, Schema } from "effect"
import {
  GraphQLBoolean,
  type GraphQLFieldConfig,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLString,
} from "graphql"
import { makeD1ServiceCatalog } from "../../adapters/D1ServiceCatalogLive.js"
import type { GraphQLContext } from "../context.js"
import { BookingError } from "../errors.js"
import { instantScalar, plainDateScalar } from "../resolver.js"

/**
 * Read-only GraphQL surface for the service catalog. The six entities
 * are exposed as one query field per `list` operation. Writes land in
 * a separate resolver module gated by `StaffCapability`.
 *
 * Each output `GraphQLObjectType` is hand-rolled to match the gold
 * SDL — the row codec ASTs go through `drizzle-orm/effect-schema`'s
 * `createSelectSchema`, which lowers `text(... mode: "json")` columns
 * to plain `Schema.String` rather than the JSON-decoded
 * `Schema.Array(...)` shape, so the AST walker in `../derive.ts` can
 * neither detect arrays nor brands on the encoded form. The
 * `Schema.encodeSync(*FromRow)(...)` runtime still produces the
 * right wire shape (the overlay decode/encode is a separate concern
 * from the AST representation).
 */

/* -------------------------------------------------------------------------- */
/* Output GraphQL types                                                        */

const serviceType = new GraphQLObjectType({
  name: "Service",
  description: "Catalog entry for a unit of work the business offers.",
  fields: () => ({
    id: { type: new GraphQLNonNull(GraphQLString) },
    name: { type: new GraphQLNonNull(GraphQLString) },
    description: { type: new GraphQLNonNull(GraphQLString) },
    durationMinutes: { type: new GraphQLNonNull(GraphQLInt) },
    bufferBeforeMinutes: { type: new GraphQLNonNull(GraphQLInt) },
    bufferAfterMinutes: { type: new GraphQLNonNull(GraphQLInt) },
    holdingDays: { type: new GraphQLNonNull(GraphQLInt) },
    requiredSkills: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLString))),
    },
    requiredResourceTypes: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLString))),
    },
    enabled: { type: new GraphQLNonNull(GraphQLBoolean) },
  }),
})

const providerType = new GraphQLObjectType({
  name: "Provider",
  description: "A person who performs the work for a Service.",
  fields: () => ({
    id: { type: new GraphQLNonNull(GraphQLString) },
    name: { type: new GraphQLNonNull(GraphQLString) },
    skills: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLString))) },
    enabled: { type: new GraphQLNonNull(GraphQLBoolean) },
  }),
})

const resourceType = new GraphQLObjectType({
  name: "Resource",
  description: "A single indivisible unit of physical capacity.",
  fields: () => ({
    id: { type: new GraphQLNonNull(GraphQLString) },
    name: { type: new GraphQLNonNull(GraphQLString) },
    type: { type: new GraphQLNonNull(GraphQLString) },
    enabled: { type: new GraphQLNonNull(GraphQLBoolean) },
  }),
})

const openWindowType = new GraphQLObjectType({
  name: "OpenWindow",
  description: "Half-open `[start, end)` time interval within a single civil day.",
  fields: () => ({
    start: { type: new GraphQLNonNull(GraphQLString) },
    end: { type: new GraphQLNonNull(GraphQLString) },
  }),
})

const businessHoursType = new GraphQLObjectType({
  name: "BusinessHours",
  description: "Open intervals for one ISO weekday (1=Mon..7=Sun).",
  fields: () => ({
    id: { type: new GraphQLNonNull(GraphQLString) },
    weekday: { type: new GraphQLNonNull(GraphQLInt) },
    windows: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(openWindowType))) },
  }),
})

const closureType = new GraphQLObjectType({
  name: "Closure",
  description: "Calendar-date business closure (overrides the weekday template).",
  fields: () => ({
    id: { type: new GraphQLNonNull(GraphQLString) },
    date: { type: new GraphQLNonNull(plainDateScalar) },
    reason: { type: new GraphQLNonNull(GraphQLString) },
  }),
})

const providerAbsenceType = new GraphQLObjectType({
  name: "ProviderAbsence",
  description: "Per-provider unavailability window (vacation, training, sick leave).",
  fields: () => ({
    id: { type: new GraphQLNonNull(GraphQLString) },
    providerId: { type: new GraphQLNonNull(GraphQLString) },
    start: { type: new GraphQLNonNull(instantScalar) },
    end: { type: new GraphQLNonNull(instantScalar) },
    reason: { type: new GraphQLNonNull(GraphQLString) },
  }),
})

/* -------------------------------------------------------------------------- */
/* Effect runner                                                               */

const runCatalog = async <A>(
  env: GraphQLContext["env"],
  program: (catalog: ServiceCatalogOps) => Effect.Effect<A, unknown>,
): Promise<A> => {
  const layer = makeD1ServiceCatalog(env.DB)
  const result = await Effect.runPromise(
    Effect.result(
      Effect.provide(
        Effect.flatMap(Effect.service(ServiceCatalog), (cat) => program(cat)),
        layer,
      ),
    ),
  )
  if (result._tag === "Success") return result.success
  throw new BookingError({
    __typename: "Storage",
    code: "E_INF_STORAGE",
    severity: "infrastructure",
    i18nKey: errorToI18nKey({ _tag: "Storage" } as StorageError),
  })
}

/* -------------------------------------------------------------------------- */
/* Query field factory                                                         */

const listOf = (t: GraphQLObjectType) => new GraphQLList(new GraphQLNonNull(t))

export const catalogQueryFields = (): Record<
  string,
  GraphQLFieldConfig<unknown, GraphQLContext>
> => ({
  services: {
    type: listOf(serviceType),
    description: "Every catalog Service, including disabled ones.",
    resolve: (_root, _args, ctx) =>
      runCatalog(ctx.env, (cat) =>
        Effect.map(cat.services.list(), (rows) =>
          rows.map((r) => Schema.encodeSync(ServiceFromRow)(r)),
        ),
      ),
  },
  providers: {
    type: listOf(providerType),
    description: "Every catalog Provider, including disabled ones.",
    resolve: (_root, _args, ctx) =>
      runCatalog(ctx.env, (cat) =>
        Effect.map(cat.providers.list(), (rows) =>
          rows.map((r) => Schema.encodeSync(ProviderFromRow)(r)),
        ),
      ),
  },
  resources: {
    type: listOf(resourceType),
    description: "Every catalog Resource, including disabled ones.",
    resolve: (_root, _args, ctx) =>
      runCatalog(ctx.env, (cat) =>
        Effect.map(cat.resources.list(), (rows) =>
          rows.map((r) => Schema.encodeSync(ResourceFromRow)(r)),
        ),
      ),
  },
  businessHours: {
    type: listOf(businessHoursType),
    description: "Weekly opening template, one row per ISO weekday.",
    resolve: (_root, _args, ctx) =>
      runCatalog(ctx.env, (cat) =>
        Effect.map(cat.businessHours.list(), (rows) =>
          rows.map((r) => Schema.encodeSync(BusinessHoursFromRow)(r)),
        ),
      ),
  },
  closures: {
    type: listOf(closureType),
    description: "Calendar-date closures (public holidays, planned maintenance).",
    resolve: (_root, _args, ctx) =>
      runCatalog(ctx.env, (cat) =>
        Effect.map(cat.closures.list(), (rows) =>
          rows.map((r) => Schema.encodeSync(ClosureFromRow)(r)),
        ),
      ),
  },
  providerAbsences: {
    type: listOf(providerAbsenceType),
    description: "Per-provider unavailability windows.",
    resolve: (_root, _args, ctx) =>
      runCatalog(ctx.env, (cat) =>
        Effect.map(cat.providerAbsences.list(), (rows) =>
          rows.map((r) => Schema.encodeSync(ProviderAbsenceFromRow)(r)),
        ),
      ),
  },
})
