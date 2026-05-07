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
import { makeD1ServiceCatalog } from "../../adapters/D1ServiceCatalogLive.js"
import { builder, type GraphQLContext } from "../builder.js"
import { BookingError } from "../errors.js"

/**
 * Read-only GraphQL surface for the service catalog. The six entities
 * are exposed as one query field per `list` operation. Writes land in
 * a separate resolver module gated by `StaffCapability`.
 *
 * Each resolver runs the port's `list()`, then encodes the entity
 * sequence through its `*FromRow` codec — `Schema.Codec.Encoded` is
 * the wire shape the GraphQL schema serialises. This keeps the
 * resolver-to-wire mapping a pure derivation: adding a column to a
 * table propagates through the row codec, the type alias, and the
 * Pothos `objectRef` shape generic without any per-resolver rewrite.
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

/* ----- Output object types — derived from `Schema.Codec.Encoded` of */
/* each `*FromRow` codec, then projected through `WireShape` to drop  */
/* brands and `readonly` qualifiers (Pothos's `exposeStringList` /    */
/* `exposeString` constrain field names to mutable, unbranded shapes  */
/* — brands are TypeScript-only, never survive the GraphQL wire).     */

type WireShape<T> = T extends string
  ? string
  : T extends number
    ? number
    : T extends boolean
      ? boolean
      : T extends readonly (infer U)[]
        ? WireShape<U>[]
        : T extends object
          ? { -readonly [K in keyof T]: WireShape<T[K]> }
          : T

type ServiceShape = WireShape<Schema.Codec.Encoded<typeof ServiceFromRow>>
type ProviderShape = WireShape<Schema.Codec.Encoded<typeof ProviderFromRow>>
type ResourceShape = WireShape<Schema.Codec.Encoded<typeof ResourceFromRow>>
type BusinessHoursShape = WireShape<Schema.Codec.Encoded<typeof BusinessHoursFromRow>>
type ClosureShape = WireShape<Schema.Codec.Encoded<typeof ClosureFromRow>>
type ProviderAbsenceShape = WireShape<Schema.Codec.Encoded<typeof ProviderAbsenceFromRow>>
type OpenWindowShape = BusinessHoursShape["windows"][number]

const wire = <T>(value: T): WireShape<T> => value as WireShape<T>

const encodeService = (s: Schema.Schema.Type<typeof ServiceFromRow>): ServiceShape =>
  wire(Schema.encodeSync(ServiceFromRow)(s))
const encodeProvider = (p: Schema.Schema.Type<typeof ProviderFromRow>): ProviderShape =>
  wire(Schema.encodeSync(ProviderFromRow)(p))
const encodeResource = (r: Schema.Schema.Type<typeof ResourceFromRow>): ResourceShape =>
  wire(Schema.encodeSync(ResourceFromRow)(r))
const encodeBusinessHours = (
  b: Schema.Schema.Type<typeof BusinessHoursFromRow>,
): BusinessHoursShape => wire(Schema.encodeSync(BusinessHoursFromRow)(b))
const encodeClosure = (c: Schema.Schema.Type<typeof ClosureFromRow>): ClosureShape =>
  wire(Schema.encodeSync(ClosureFromRow)(c))
const encodeProviderAbsence = (
  a: Schema.Schema.Type<typeof ProviderAbsenceFromRow>,
): ProviderAbsenceShape => wire(Schema.encodeSync(ProviderAbsenceFromRow)(a))

const ServiceType = builder.objectRef<ServiceShape>("Service").implement({
  description: "Catalog entry for a unit of work the business offers.",
  fields: (t) => ({
    id: t.exposeString("id"),
    name: t.exposeString("name"),
    description: t.exposeString("description"),
    durationMinutes: t.exposeInt("durationMinutes"),
    bufferBeforeMinutes: t.exposeInt("bufferBeforeMinutes"),
    bufferAfterMinutes: t.exposeInt("bufferAfterMinutes"),
    holdingDays: t.exposeInt("holdingDays"),
    requiredSkills: t.exposeStringList("requiredSkills"),
    requiredResourceTypes: t.exposeStringList("requiredResourceTypes"),
    enabled: t.exposeBoolean("enabled"),
  }),
})

const ProviderType = builder.objectRef<ProviderShape>("Provider").implement({
  description: "A person who performs the work for a Service.",
  fields: (t) => ({
    id: t.exposeString("id"),
    name: t.exposeString("name"),
    skills: t.exposeStringList("skills"),
    enabled: t.exposeBoolean("enabled"),
  }),
})

const ResourceType = builder.objectRef<ResourceShape>("Resource").implement({
  description: "A single indivisible unit of physical capacity.",
  fields: (t) => ({
    id: t.exposeString("id"),
    name: t.exposeString("name"),
    type: t.exposeString("type"),
    enabled: t.exposeBoolean("enabled"),
  }),
})

const OpenWindowType = builder.objectRef<OpenWindowShape>("OpenWindow").implement({
  description: "Half-open `[start, end)` time interval within a single civil day.",
  fields: (t) => ({
    start: t.exposeString("start"),
    end: t.exposeString("end"),
  }),
})

const BusinessHoursType = builder.objectRef<BusinessHoursShape>("BusinessHours").implement({
  description: "Open intervals for one ISO weekday (1=Mon..7=Sun).",
  fields: (t) => ({
    id: t.exposeString("id"),
    weekday: t.exposeInt("weekday"),
    windows: t.field({ type: [OpenWindowType], resolve: (b) => b.windows }),
  }),
})

const ClosureType = builder.objectRef<ClosureShape>("Closure").implement({
  description: "Calendar-date business closure (overrides the weekday template).",
  fields: (t) => ({
    id: t.exposeString("id"),
    date: t.field({ type: "PlainDate", resolve: (c) => c.date }),
    reason: t.exposeString("reason"),
  }),
})

const ProviderAbsenceType = builder.objectRef<ProviderAbsenceShape>("ProviderAbsence").implement({
  description: "Per-provider unavailability window (vacation, training, sick leave).",
  fields: (t) => ({
    id: t.exposeString("id"),
    providerId: t.exposeString("providerId"),
    start: t.field({ type: "Instant", resolve: (a) => a.start }),
    end: t.field({ type: "Instant", resolve: (a) => a.end }),
    reason: t.exposeString("reason"),
  }),
})

builder.queryFields((t) => ({
  services: t.field({
    type: [ServiceType],
    description: "Every catalog Service, including disabled ones.",
    resolve: (_root, _args, ctx) =>
      runCatalog(ctx.env, (cat) =>
        Effect.map(cat.services.list(), (rows) => rows.map((s) => encodeService(s))),
      ),
  }),
  providers: t.field({
    type: [ProviderType],
    description: "Every catalog Provider, including disabled ones.",
    resolve: (_root, _args, ctx) =>
      runCatalog(ctx.env, (cat) =>
        Effect.map(cat.providers.list(), (rows) => rows.map((p) => encodeProvider(p))),
      ),
  }),
  resources: t.field({
    type: [ResourceType],
    description: "Every catalog Resource, including disabled ones.",
    resolve: (_root, _args, ctx) =>
      runCatalog(ctx.env, (cat) =>
        Effect.map(cat.resources.list(), (rows) => rows.map((r) => encodeResource(r))),
      ),
  }),
  businessHours: t.field({
    type: [BusinessHoursType],
    description: "Weekly opening template, one row per ISO weekday.",
    resolve: (_root, _args, ctx) =>
      runCatalog(ctx.env, (cat) =>
        Effect.map(cat.businessHours.list(), (rows) => rows.map((b) => encodeBusinessHours(b))),
      ),
  }),
  closures: t.field({
    type: [ClosureType],
    description: "Calendar-date closures (public holidays, planned maintenance).",
    resolve: (_root, _args, ctx) =>
      runCatalog(ctx.env, (cat) =>
        Effect.map(cat.closures.list(), (rows) => rows.map((c) => encodeClosure(c))),
      ),
  }),
  providerAbsences: t.field({
    type: [ProviderAbsenceType],
    description: "Per-provider unavailability windows.",
    resolve: (_root, _args, ctx) =>
      runCatalog(ctx.env, (cat) =>
        Effect.map(cat.providerAbsences.list(), (rows) =>
          rows.map((a) => encodeProviderAbsence(a)),
        ),
      ),
  }),
}))
