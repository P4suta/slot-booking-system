import {
  BusinessHoursSchema,
  type Capability,
  CapabilitySchema,
  ClosureSchema,
  type DomainError,
  errorToGraphQLPayload,
  hasScope,
  InsufficientCapabilityError,
  InvalidCatalogInputError,
  MissingStaffCapabilityError,
  newBusinessHoursId,
  newClosureId,
  newProviderAbsenceId,
  newProviderId,
  newResourceId,
  newServiceId,
  ProviderAbsenceSchema,
  ProviderSchema,
  ResourceSchema,
  ServiceCatalog,
  type ServiceCatalogOps,
  ServiceSchema,
  type StaffCapability,
  type StaffScope,
  summarizeParse,
} from "@booking/core"
import { Effect, Schema } from "effect"
import {
  type GraphQLFieldConfig,
  type GraphQLInputObjectType,
  GraphQLNonNull,
  type GraphQLObjectType,
  GraphQLString,
} from "graphql"
import { makeD1ServiceCatalog } from "../../adapters/D1ServiceCatalogLive.js"
import type { GraphQLContext } from "../context.js"
import {
  makeInputTypeRegistry,
  schemaToGraphQLInputType,
  schemaToGraphQLOutputType,
} from "../derive.js"
import { BookingError } from "../errors.js"
import { type ErrorEnvelopeRegistry, errorEnvelope } from "../resolver.js"

/**
 * Staff-only mutations for the catalog. The capability check lives at
 * the GraphQL boundary — the port itself is unscoped — so the resolver
 * is the single place where "is this caller authorised to write the
 * catalog?" is asked.
 *
 * **Capability extraction (Phase 0.8 stance)** — Cloudflare Access
 * sits in front of the staff dashboard in the production wiring; the
 * Worker reads the JWT it sets and lifts the verified claim into a
 * `StaffCapability`. Phase 0.11-7 closes that loop. For the local
 * `wrangler dev` flow we honour an `X-Staff-Capability` header
 * carrying base64url-encoded JSON of the same `StaffCapability`
 * shape; the parse and Schema-decode pipeline is identical, only the
 * source differs. There is no quiet fallback — a missing or invalid
 * header refuses the mutation.
 *
 * **Scope** — every catalog write requires the `manage_catalog`
 * scope. The four per-booking scopes (`cancel` / `reschedule` /
 * `complete` / `noshow`) intentionally do *not* satisfy a catalog
 * write; an operator's manage-catalog permission is a separate role.
 */

const decodeCapability = Schema.decodeUnknownResult(CapabilitySchema)

const liftDomainError = (e: DomainError): BookingError => new BookingError(errorToGraphQLPayload(e))

const refuseHeader = (reason: "absent" | "malformed" | "wrong_kind"): BookingError =>
  liftDomainError(new MissingStaffCapabilityError({ reason }))

const decodeBase64Json = (raw: string): unknown => {
  try {
    const padded = raw + "=".repeat((4 - (raw.length % 4)) % 4)
    const normalised = padded.replace(/-/g, "+").replace(/_/g, "/")
    return JSON.parse(atob(normalised))
  } catch {
    throw refuseHeader("malformed")
  }
}

const requireStaffScope = (request: Request, scope: StaffScope): StaffCapability => {
  const header = request.headers.get("x-staff-capability")
  if (header === null) throw refuseHeader("absent")
  const decoded = decodeCapability(decodeBase64Json(header))
  if (decoded._tag === "Failure") throw refuseHeader("malformed")
  const cap: Capability = decoded.success
  if (cap._tag !== "StaffCapability") throw refuseHeader("wrong_kind")
  if (!hasScope(cap, scope)) {
    throw liftDomainError(
      new InsufficientCapabilityError({ required: scope, capability: cap._tag }),
    )
  }
  return cap
}

const runCatalog = async <A>(
  env: GraphQLContext["env"],
  program: (catalog: ServiceCatalogOps) => Effect.Effect<A, DomainError>,
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
  throw liftDomainError(result.failure)
}

/* -------------------------------------------------------------------------- */
/* Output mutation result + input Schema sources                               */
/* -------------------------------------------------------------------------- */

type MutationResultShape = { readonly id: string }

/**
 * Wire shape for staff mutations' success arm. The Schema source
 * drives the GraphQL output type via the functor; schema-faithful
 * nullability makes `id` non-null.
 */
const CatalogMutationResultSchema = Schema.Struct({ id: Schema.String })
const catalogMutationResultType = schemaToGraphQLOutputType(CatalogMutationResultSchema, {
  name: "CatalogMutationResult",
  description: "Identity of the catalog row written by a staff mutation.",
}) as GraphQLObjectType

/**
 * Schema sources for the nine `*Input` GraphQL input types.
 *
 * Each schema is a stand-alone source-of-truth for the wire shape;
 * `Schema.optional` marks fields the client may omit (only `id` —
 * the staff-side mint path generates a fresh id when absent), and
 * the integer-bound fields use `Schema.Number.check(Schema.isInt())`
 * so the functor's `Number → GraphQLInt` detection lifts them
 * correctly. Nested struct names propagate through the
 * `identifier` annotation so `requiredSkills: SkillListInput!` /
 * `windows: [OpenWindowInput!]!` resolve to named members rather
 * than to anonymous structs.
 */

const SkillListInputSchema = Schema.Struct({
  values: Schema.Array(Schema.String),
}).annotate({ identifier: "SkillListInput" })

const ResourceTypeListInputSchema = Schema.Struct({
  values: Schema.Array(Schema.String),
}).annotate({ identifier: "ResourceTypeListInput" })

const OpenWindowInputSchema = Schema.Struct({
  start: Schema.String,
  end: Schema.String,
}).annotate({ identifier: "OpenWindowInput" })

const ServiceInputSchema = Schema.Struct({
  id: Schema.optional(Schema.String),
  name: Schema.String,
  description: Schema.String,
  durationMinutes: Schema.Number.check(Schema.isInt()),
  bufferBeforeMinutes: Schema.Number.check(Schema.isInt()),
  bufferAfterMinutes: Schema.Number.check(Schema.isInt()),
  holdingDays: Schema.Number.check(Schema.isInt()),
  requiredSkills: SkillListInputSchema,
  requiredResourceTypes: ResourceTypeListInputSchema,
  enabled: Schema.Boolean,
}).annotate({ identifier: "ServiceInput" })

const ProviderInputSchema = Schema.Struct({
  id: Schema.optional(Schema.String),
  name: Schema.String,
  skills: SkillListInputSchema,
  enabled: Schema.Boolean,
}).annotate({ identifier: "ProviderInput" })

const ResourceInputSchema = Schema.Struct({
  id: Schema.optional(Schema.String),
  name: Schema.String,
  type: Schema.String,
  enabled: Schema.Boolean,
}).annotate({ identifier: "ResourceInput" })

const BusinessHoursInputSchema = Schema.Struct({
  id: Schema.optional(Schema.String),
  weekday: Schema.Number.check(Schema.isInt()),
  windows: Schema.Array(OpenWindowInputSchema),
}).annotate({ identifier: "BusinessHoursInput" })

const ClosureInputSchema = Schema.Struct({
  id: Schema.optional(Schema.String),
  date: Schema.String,
  reason: Schema.String,
}).annotate({ identifier: "ClosureInput" })

const ProviderAbsenceInputSchema = Schema.Struct({
  id: Schema.optional(Schema.String),
  providerId: Schema.String,
  start: Schema.String,
  end: Schema.String,
  reason: Schema.String,
}).annotate({ identifier: "ProviderAbsenceInput" })

const inputRegistry = makeInputTypeRegistry()

const inputTypeOf = (s: Schema.Top, name: string): GraphQLInputObjectType =>
  schemaToGraphQLInputType(s, { name, registry: inputRegistry }) as GraphQLInputObjectType

const skillListInput = inputTypeOf(SkillListInputSchema, "SkillListInput")
const resourceTypeListInput = inputTypeOf(ResourceTypeListInputSchema, "ResourceTypeListInput")
const openWindowInput = inputTypeOf(OpenWindowInputSchema, "OpenWindowInput")
const serviceInput = inputTypeOf(ServiceInputSchema, "ServiceInput")
const providerInput = inputTypeOf(ProviderInputSchema, "ProviderInput")
const resourceInput = inputTypeOf(ResourceInputSchema, "ResourceInput")
const businessHoursInput = inputTypeOf(BusinessHoursInputSchema, "BusinessHoursInput")
const closureInput = inputTypeOf(ClosureInputSchema, "ClosureInput")
const providerAbsenceInput = inputTypeOf(ProviderAbsenceInputSchema, "ProviderAbsenceInput")

// Force lazy `fields` thunks to materialise so any derivation drift
// surfaces at module load. Also keeps knip from flagging the input
// references as unused — the resolver field configs reference them.
void [
  skillListInput,
  resourceTypeListInput,
  openWindowInput,
  providerInput,
  resourceInput,
  closureInput,
  providerAbsenceInput,
]

const decodeOrRefuse = <E, R>(
  entity: InvalidCatalogInputError["entity"],
  schema: Schema.Codec<E, R>,
  raw: unknown,
): E => {
  const r = Schema.decodeUnknownResult(schema)(raw)
  if (r._tag === "Success") return r.success
  throw liftDomainError(new InvalidCatalogInputError({ entity, reason: summarizeParse(r.failure) }))
}

/* -------------------------------------------------------------------------- */
/* Mutation field factory                                                      */

type SkillListInputShape = { readonly values: readonly string[] }
type ResourceTypeListInputShape = { readonly values: readonly string[] }
type OpenWindowInputShape = { readonly start: string; readonly end: string }

type ServiceInputShape = {
  readonly id?: string
  readonly name: string
  readonly description: string
  readonly durationMinutes: number
  readonly bufferBeforeMinutes: number
  readonly bufferAfterMinutes: number
  readonly holdingDays: number
  readonly requiredSkills: SkillListInputShape
  readonly requiredResourceTypes: ResourceTypeListInputShape
  readonly enabled: boolean
}

type ProviderInputShape = {
  readonly id?: string
  readonly name: string
  readonly skills: SkillListInputShape
  readonly enabled: boolean
}

type ResourceInputShape = {
  readonly id?: string
  readonly name: string
  readonly type: string
  readonly enabled: boolean
}

type BusinessHoursInputShape = {
  readonly id?: string
  readonly weekday: number
  readonly windows: readonly OpenWindowInputShape[]
}

type ClosureInputShape = {
  readonly id?: string
  readonly date: string
  readonly reason: string
}

type ProviderAbsenceInputShape = {
  readonly id?: string
  readonly providerId: string
  readonly start: string
  readonly end: string
  readonly reason: string
}

const idArg = { id: { type: new GraphQLNonNull(GraphQLString) } }

export const staffCatalogMutationFields = (
  registry: ErrorEnvelopeRegistry,
): Record<string, GraphQLFieldConfig<unknown, GraphQLContext>> => ({
  saveService: errorEnvelope({
    verb: "SaveService",
    inner: catalogMutationResultType,
    args: { input: { type: new GraphQLNonNull(serviceInput) } },
    description: "Upsert a Service. Requires StaffCapability with `manage_catalog`.",
    registry,
    body: async (rawArgs, ctx): Promise<MutationResultShape> => {
      const { input } = rawArgs as { readonly input: ServiceInputShape }
      requireStaffScope(ctx.request, "manage_catalog")
      const id = input.id ?? newServiceId()
      const entity = decodeOrRefuse("service", ServiceSchema, {
        id,
        name: input.name,
        description: input.description,
        durationMinutes: input.durationMinutes,
        bufferBeforeMinutes: input.bufferBeforeMinutes,
        bufferAfterMinutes: input.bufferAfterMinutes,
        holdingDays: input.holdingDays,
        requiredSkills: input.requiredSkills.values,
        requiredResourceTypes: input.requiredResourceTypes.values,
        enabled: input.enabled,
      })
      await runCatalog(ctx.env, (cat) => cat.services.save(entity))
      return { id }
    },
  }),

  deleteService: errorEnvelope({
    verb: "DeleteService",
    inner: catalogMutationResultType,
    args: idArg,
    description: "Delete a Service by id. Requires StaffCapability with `manage_catalog`.",
    registry,
    body: async (rawArgs, ctx): Promise<MutationResultShape> => {
      const { id } = rawArgs as { readonly id: string }
      requireStaffScope(ctx.request, "manage_catalog")
      const decoded = decodeOrRefuse("service", ServiceSchema.fields.id, id)
      await runCatalog(ctx.env, (cat) => cat.services.delete(decoded))
      return { id }
    },
  }),

  saveProvider: errorEnvelope({
    verb: "SaveProvider",
    inner: catalogMutationResultType,
    args: { input: { type: new GraphQLNonNull(providerInput) } },
    description: "Upsert a Provider. Requires StaffCapability with `manage_catalog`.",
    registry,
    body: async (rawArgs, ctx): Promise<MutationResultShape> => {
      const { input } = rawArgs as { readonly input: ProviderInputShape }
      requireStaffScope(ctx.request, "manage_catalog")
      const id = input.id ?? newProviderId()
      const entity = decodeOrRefuse("provider", ProviderSchema, {
        id,
        name: input.name,
        skills: input.skills.values,
        enabled: input.enabled,
      })
      await runCatalog(ctx.env, (cat) => cat.providers.save(entity))
      return { id }
    },
  }),

  deleteProvider: errorEnvelope({
    verb: "DeleteProvider",
    inner: catalogMutationResultType,
    args: idArg,
    description: "Delete a Provider by id. Requires StaffCapability with `manage_catalog`.",
    registry,
    body: async (rawArgs, ctx): Promise<MutationResultShape> => {
      const { id } = rawArgs as { readonly id: string }
      requireStaffScope(ctx.request, "manage_catalog")
      const decoded = decodeOrRefuse("provider", ProviderSchema.fields.id, id)
      await runCatalog(ctx.env, (cat) => cat.providers.delete(decoded))
      return { id }
    },
  }),

  saveResource: errorEnvelope({
    verb: "SaveResource",
    inner: catalogMutationResultType,
    args: { input: { type: new GraphQLNonNull(resourceInput) } },
    description: "Upsert a Resource. Requires StaffCapability with `manage_catalog`.",
    registry,
    body: async (rawArgs, ctx): Promise<MutationResultShape> => {
      const { input } = rawArgs as { readonly input: ResourceInputShape }
      requireStaffScope(ctx.request, "manage_catalog")
      const id = input.id ?? newResourceId()
      const entity = decodeOrRefuse("resource", ResourceSchema, {
        id,
        name: input.name,
        type: input.type,
        enabled: input.enabled,
      })
      await runCatalog(ctx.env, (cat) => cat.resources.save(entity))
      return { id }
    },
  }),

  deleteResource: errorEnvelope({
    verb: "DeleteResource",
    inner: catalogMutationResultType,
    args: idArg,
    description: "Delete a Resource by id. Requires StaffCapability with `manage_catalog`.",
    registry,
    body: async (rawArgs, ctx): Promise<MutationResultShape> => {
      const { id } = rawArgs as { readonly id: string }
      requireStaffScope(ctx.request, "manage_catalog")
      const decoded = decodeOrRefuse("resource", ResourceSchema.fields.id, id)
      await runCatalog(ctx.env, (cat) => cat.resources.delete(decoded))
      return { id }
    },
  }),

  saveBusinessHours: errorEnvelope({
    verb: "SaveBusinessHours",
    inner: catalogMutationResultType,
    args: { input: { type: new GraphQLNonNull(businessHoursInput) } },
    description: "Upsert a BusinessHours row. Requires StaffCapability with `manage_catalog`.",
    registry,
    body: async (rawArgs, ctx): Promise<MutationResultShape> => {
      const { input } = rawArgs as { readonly input: BusinessHoursInputShape }
      requireStaffScope(ctx.request, "manage_catalog")
      const id = input.id ?? newBusinessHoursId()
      const entity = decodeOrRefuse("businessHours", BusinessHoursSchema, {
        id,
        weekday: input.weekday,
        windows: input.windows.map((w) => ({ start: w.start, end: w.end })),
      })
      await runCatalog(ctx.env, (cat) => cat.businessHours.save(entity))
      return { id }
    },
  }),

  deleteBusinessHours: errorEnvelope({
    verb: "DeleteBusinessHours",
    inner: catalogMutationResultType,
    args: idArg,
    description:
      "Delete a BusinessHours row by id. Requires StaffCapability with `manage_catalog`.",
    registry,
    body: async (rawArgs, ctx): Promise<MutationResultShape> => {
      const { id } = rawArgs as { readonly id: string }
      requireStaffScope(ctx.request, "manage_catalog")
      const decoded = decodeOrRefuse("businessHours", BusinessHoursSchema.fields.id, id)
      await runCatalog(ctx.env, (cat) => cat.businessHours.delete(decoded))
      return { id }
    },
  }),

  saveClosure: errorEnvelope({
    verb: "SaveClosure",
    inner: catalogMutationResultType,
    args: { input: { type: new GraphQLNonNull(closureInput) } },
    description: "Upsert a Closure. Requires StaffCapability with `manage_catalog`.",
    registry,
    body: async (rawArgs, ctx): Promise<MutationResultShape> => {
      const { input } = rawArgs as { readonly input: ClosureInputShape }
      requireStaffScope(ctx.request, "manage_catalog")
      const id = input.id ?? newClosureId()
      const entity = decodeOrRefuse("closure", ClosureSchema, {
        id,
        date: input.date,
        reason: input.reason,
      })
      await runCatalog(ctx.env, (cat) => cat.closures.save(entity))
      return { id }
    },
  }),

  deleteClosure: errorEnvelope({
    verb: "DeleteClosure",
    inner: catalogMutationResultType,
    args: idArg,
    description: "Delete a Closure by id. Requires StaffCapability with `manage_catalog`.",
    registry,
    body: async (rawArgs, ctx): Promise<MutationResultShape> => {
      const { id } = rawArgs as { readonly id: string }
      requireStaffScope(ctx.request, "manage_catalog")
      const decoded = decodeOrRefuse("closure", ClosureSchema.fields.id, id)
      await runCatalog(ctx.env, (cat) => cat.closures.delete(decoded))
      return { id }
    },
  }),

  saveProviderAbsence: errorEnvelope({
    verb: "SaveProviderAbsence",
    inner: catalogMutationResultType,
    args: { input: { type: new GraphQLNonNull(providerAbsenceInput) } },
    description: "Upsert a ProviderAbsence. Requires StaffCapability with `manage_catalog`.",
    registry,
    body: async (rawArgs, ctx): Promise<MutationResultShape> => {
      const { input } = rawArgs as { readonly input: ProviderAbsenceInputShape }
      requireStaffScope(ctx.request, "manage_catalog")
      const id = input.id ?? newProviderAbsenceId()
      const entity = decodeOrRefuse("providerAbsence", ProviderAbsenceSchema, {
        id,
        providerId: input.providerId,
        start: input.start,
        end: input.end,
        reason: input.reason,
      })
      await runCatalog(ctx.env, (cat) => cat.providerAbsences.save(entity))
      return { id }
    },
  }),

  deleteProviderAbsence: errorEnvelope({
    verb: "DeleteProviderAbsence",
    inner: catalogMutationResultType,
    args: idArg,
    description: "Delete a ProviderAbsence by id. Requires StaffCapability with `manage_catalog`.",
    registry,
    body: async (rawArgs, ctx): Promise<MutationResultShape> => {
      const { id } = rawArgs as { readonly id: string }
      requireStaffScope(ctx.request, "manage_catalog")
      const decoded = decodeOrRefuse("providerAbsence", ProviderAbsenceSchema.fields.id, id)
      await runCatalog(ctx.env, (cat) => cat.providerAbsences.delete(decoded))
      return { id }
    },
  }),
})
