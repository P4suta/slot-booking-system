import { ServiceCatalog, type ServiceCatalogOps } from "@booking/core"
import { Effect } from "effect"
import { makeD1ServiceCatalog } from "../../adapters/D1ServiceCatalogLive.js"
import { builder, type GraphQLContext } from "../builder.js"
import { BookingError } from "../errors.js"

/**
 * Read-only GraphQL surface for the service catalog. The six entities
 * are exposed as one query field per `list` operation. Writes land in
 * a separate resolver module gated by `StaffCapability`.
 *
 * Each resolver is a one-line wiring through the catalog port: the
 * D1 adapter built per-request, the Effect program runs `list()`, and
 * the encoded form (Schema's wire shape) is what GraphQL serialises.
 * Returning the encoded form keeps the GraphQL types in lockstep with
 * the SQL columns — the read side never sees the in-memory Temporal /
 * Set / brand layer, only the codec output.
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
  // a second arm.
  throw new BookingError({
    _tag: "Storage",
    code: "E_INF_STORAGE",
    severity: "infrastructure",
  })
}

/* ----- Output object types ----- */

type ServiceShape = {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly durationMinutes: number
  readonly bufferBeforeMinutes: number
  readonly bufferAfterMinutes: number
  readonly holdingDays: number
  readonly requiredSkills: readonly string[]
  readonly requiredResourceTypes: readonly string[]
  readonly enabled: boolean
}

type ProviderShape = {
  readonly id: string
  readonly name: string
  readonly skills: readonly string[]
  readonly enabled: boolean
}

type ResourceShape = {
  readonly id: string
  readonly name: string
  readonly type: string
  readonly enabled: boolean
}

type OpenWindowShape = { readonly start: string; readonly end: string }

type BusinessHoursShape = {
  readonly id: string
  readonly weekday: number
  readonly windows: readonly OpenWindowShape[]
}

type ClosureShape = {
  readonly id: string
  readonly date: string
  readonly reason: string
}

type ProviderAbsenceShape = {
  readonly id: string
  readonly providerId: string
  readonly start: string
  readonly end: string
  readonly reason: string
}

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
        Effect.map(cat.services.list(), (rows) =>
          rows.map(
            (s): ServiceShape => ({
              id: s.id,
              name: s.name,
              description: s.description,
              durationMinutes: s.durationMinutes,
              bufferBeforeMinutes: s.bufferBeforeMinutes,
              bufferAfterMinutes: s.bufferAfterMinutes,
              holdingDays: s.holdingDays,
              requiredSkills: [...s.requiredSkills],
              requiredResourceTypes: [...s.requiredResourceTypes],
              enabled: s.enabled,
            }),
          ),
        ),
      ),
  }),
  providers: t.field({
    type: [ProviderType],
    description: "Every catalog Provider, including disabled ones.",
    resolve: (_root, _args, ctx) =>
      runCatalog(ctx.env, (cat) =>
        Effect.map(cat.providers.list(), (rows) =>
          rows.map(
            (p): ProviderShape => ({
              id: p.id,
              name: p.name,
              skills: [...p.skills],
              enabled: p.enabled,
            }),
          ),
        ),
      ),
  }),
  resources: t.field({
    type: [ResourceType],
    description: "Every catalog Resource, including disabled ones.",
    resolve: (_root, _args, ctx) =>
      runCatalog(ctx.env, (cat) =>
        Effect.map(cat.resources.list(), (rows) =>
          rows.map(
            (r): ResourceShape => ({
              id: r.id,
              name: r.name,
              type: r.type,
              enabled: r.enabled,
            }),
          ),
        ),
      ),
  }),
  businessHours: t.field({
    type: [BusinessHoursType],
    description: "Weekly opening template, one row per ISO weekday.",
    resolve: (_root, _args, ctx) =>
      runCatalog(ctx.env, (cat) =>
        Effect.map(cat.businessHours.list(), (rows) =>
          rows.map(
            (bh): BusinessHoursShape => ({
              id: bh.id,
              weekday: bh.weekday,
              windows: bh.windows.map((w) => ({
                start: w.start.toString(),
                end: w.end.toString(),
              })),
            }),
          ),
        ),
      ),
  }),
  closures: t.field({
    type: [ClosureType],
    description: "Calendar-date closures (public holidays, planned maintenance).",
    resolve: (_root, _args, ctx) =>
      runCatalog(ctx.env, (cat) =>
        Effect.map(cat.closures.list(), (rows) =>
          rows.map(
            (c): ClosureShape => ({
              id: c.id,
              date: c.date.toString(),
              reason: c.reason,
            }),
          ),
        ),
      ),
  }),
  providerAbsences: t.field({
    type: [ProviderAbsenceType],
    description: "Per-provider unavailability windows.",
    resolve: (_root, _args, ctx) =>
      runCatalog(ctx.env, (cat) =>
        Effect.map(cat.providerAbsences.list(), (rows) =>
          rows.map(
            (a): ProviderAbsenceShape => ({
              id: a.id,
              providerId: a.providerId,
              start: a.start.toString(),
              end: a.end.toString(),
              reason: a.reason,
            }),
          ),
        ),
      ),
  }),
}))
