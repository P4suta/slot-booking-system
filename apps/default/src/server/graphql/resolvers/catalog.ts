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
 * Each resolver runs the port's `list()`, then encodes the entity
 * sequence through its `*FromRow` codec — `Schema.Codec.Encoded` is
 * the wire shape the GraphQL schema serialises. This keeps the
 * resolver-to-wire mapping a pure derivation: adding a column to a
 * table propagates through the row codec and the encoded shape, while
 * the GraphQL output type stays a hand-rolled `GraphQLObjectType` (the
 * Schema → GraphQL functor at `../derive.ts` does not yet detect
 * `Schema.Int` annotations or custom-scalar branding, so the byte-
 * equal SDL constraint forces a hand-rolled construction here; the
 * functor extension is recorded as a deferred ADR-0041 follow-up).
 */

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
  // Catalog reads can fail with `StorageError`; surface as a typed
  // BookingError so the existing client error union covers it without
  // a second arm. The synthetic GraphQLErrorPayload mirrors what
  // `errorToGraphQLPayload(new StorageError(...))` would produce
  // without forcing the Effect.result failure type to widen back to
  // a concrete StorageError instance.
  throw new BookingError({
    __typename: "Storage",
    code: "E_INF_STORAGE",
    severity: "infrastructure",
    i18nKey: errorToI18nKey({ _tag: "Storage" } as StorageError),
  })
}

/* -------------------------------------------------------------------------- */
/* Output GraphQL types — hand-rolled to match the gold SDL anchor at         */
/* `apps/default/schema.graphql` (descriptions, field types, custom-scalar    */
/* mapping). All output fields default to nullable, matching Pothos's         */
/* baseline; list-element non-null wrap (`[X!]`) carries through unchanged.   */

const serviceType = new GraphQLObjectType({
  name: "Service",
  description: "Catalog entry for a unit of work the business offers.",
  fields: () => ({
    id: { type: GraphQLString },
    name: { type: GraphQLString },
    description: { type: GraphQLString },
    durationMinutes: { type: GraphQLInt },
    bufferBeforeMinutes: { type: GraphQLInt },
    bufferAfterMinutes: { type: GraphQLInt },
    holdingDays: { type: GraphQLInt },
    requiredSkills: { type: new GraphQLList(new GraphQLNonNull(GraphQLString)) },
    requiredResourceTypes: { type: new GraphQLList(new GraphQLNonNull(GraphQLString)) },
    enabled: { type: GraphQLBoolean },
  }),
})

const providerType = new GraphQLObjectType({
  name: "Provider",
  description: "A person who performs the work for a Service.",
  fields: () => ({
    id: { type: GraphQLString },
    name: { type: GraphQLString },
    skills: { type: new GraphQLList(new GraphQLNonNull(GraphQLString)) },
    enabled: { type: GraphQLBoolean },
  }),
})

const resourceType = new GraphQLObjectType({
  name: "Resource",
  description: "A single indivisible unit of physical capacity.",
  fields: () => ({
    id: { type: GraphQLString },
    name: { type: GraphQLString },
    type: { type: GraphQLString },
    enabled: { type: GraphQLBoolean },
  }),
})

const openWindowType = new GraphQLObjectType({
  name: "OpenWindow",
  description: "Half-open `[start, end)` time interval within a single civil day.",
  fields: () => ({
    start: { type: GraphQLString },
    end: { type: GraphQLString },
  }),
})

const businessHoursType = new GraphQLObjectType({
  name: "BusinessHours",
  description: "Open intervals for one ISO weekday (1=Mon..7=Sun).",
  fields: () => ({
    id: { type: GraphQLString },
    weekday: { type: GraphQLInt },
    windows: { type: new GraphQLList(new GraphQLNonNull(openWindowType)) },
  }),
})

const closureType = new GraphQLObjectType({
  name: "Closure",
  description: "Calendar-date business closure (overrides the weekday template).",
  fields: () => ({
    id: { type: GraphQLString },
    date: { type: plainDateScalar },
    reason: { type: GraphQLString },
  }),
})

const providerAbsenceType = new GraphQLObjectType({
  name: "ProviderAbsence",
  description: "Per-provider unavailability window (vacation, training, sick leave).",
  fields: () => ({
    id: { type: GraphQLString },
    providerId: { type: GraphQLString },
    start: { type: instantScalar },
    end: { type: instantScalar },
    reason: { type: GraphQLString },
  }),
})

/* -------------------------------------------------------------------------- */
/* Query field factory                                                         */

export const catalogQueryFields = (): Record<
  string,
  GraphQLFieldConfig<unknown, GraphQLContext>
> => ({
  services: {
    type: new GraphQLList(new GraphQLNonNull(serviceType)),
    description: "Every catalog Service, including disabled ones.",
    resolve: (_root, _args, ctx) =>
      runCatalog(ctx.env, (cat) =>
        Effect.map(cat.services.list(), (rows) =>
          rows.map((r) => Schema.encodeSync(ServiceFromRow)(r)),
        ),
      ),
  },
  providers: {
    type: new GraphQLList(new GraphQLNonNull(providerType)),
    description: "Every catalog Provider, including disabled ones.",
    resolve: (_root, _args, ctx) =>
      runCatalog(ctx.env, (cat) =>
        Effect.map(cat.providers.list(), (rows) =>
          rows.map((r) => Schema.encodeSync(ProviderFromRow)(r)),
        ),
      ),
  },
  resources: {
    type: new GraphQLList(new GraphQLNonNull(resourceType)),
    description: "Every catalog Resource, including disabled ones.",
    resolve: (_root, _args, ctx) =>
      runCatalog(ctx.env, (cat) =>
        Effect.map(cat.resources.list(), (rows) =>
          rows.map((r) => Schema.encodeSync(ResourceFromRow)(r)),
        ),
      ),
  },
  businessHours: {
    type: new GraphQLList(new GraphQLNonNull(businessHoursType)),
    description: "Weekly opening template, one row per ISO weekday.",
    resolve: (_root, _args, ctx) =>
      runCatalog(ctx.env, (cat) =>
        Effect.map(cat.businessHours.list(), (rows) =>
          rows.map((r) => Schema.encodeSync(BusinessHoursFromRow)(r)),
        ),
      ),
  },
  closures: {
    type: new GraphQLList(new GraphQLNonNull(closureType)),
    description: "Calendar-date closures (public holidays, planned maintenance).",
    resolve: (_root, _args, ctx) =>
      runCatalog(ctx.env, (cat) =>
        Effect.map(cat.closures.list(), (rows) =>
          rows.map((r) => Schema.encodeSync(ClosureFromRow)(r)),
        ),
      ),
  },
  providerAbsences: {
    type: new GraphQLList(new GraphQLNonNull(providerAbsenceType)),
    description: "Per-provider unavailability windows.",
    resolve: (_root, _args, ctx) =>
      runCatalog(ctx.env, (cat) =>
        Effect.map(cat.providerAbsences.list(), (rows) =>
          rows.map((r) => Schema.encodeSync(ProviderAbsenceFromRow)(r)),
        ),
      ),
  },
})
