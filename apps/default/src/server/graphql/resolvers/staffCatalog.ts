import {
  BusinessHoursSchema,
  type Capability,
  CapabilitySchema,
  ClosureSchema,
  codeOf,
  type DomainError,
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
  severityOf,
  summarizeParse,
} from "@booking/core"
import { Effect, Schema } from "effect"
import { makeD1ServiceCatalog } from "../../adapters/D1ServiceCatalogLive.js"
import { builder, type GraphQLContext } from "../builder.js"
import { BookingError } from "../errors.js"

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

const decodeCapability = Schema.decodeUnknownEither(CapabilitySchema)

/**
 * Lift any `DomainError` into the GraphQL `BookingError` arm. The
 * `_tag` / `code` / `severity` carry through unchanged so the client
 * can branch on the precise failure category — Validation
 * (`InvalidCatalogInput` / `MissingStaffCapability`) vs DomainRule
 * (`InsufficientCapability`) vs Infrastructure (`Storage`) — rather
 * than seeing every refusal collapse into a single tag.
 */
const liftDomainError = (e: DomainError): BookingError =>
  new BookingError({ _tag: e._tag, code: codeOf(e), severity: severityOf(e) })

/** Refuse a missing or malformed `StaffCapability` envelope. */
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
  if (decoded._tag === "Left") throw refuseHeader("malformed")
  const cap: Capability = decoded.right
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
    Effect.either(
      Effect.provide(
        Effect.flatMap(ServiceCatalog, (cat) => program(cat)),
        layer,
      ),
    ),
  )
  if (result._tag === "Right") return result.right
  throw liftDomainError(result.left)
}

/* -------------------------------------------------------------------------- */
/* Result + input scaffolding                                                  */
/* -------------------------------------------------------------------------- */

type MutationResultShape = { readonly id: string }

const MutationResultType = builder
  .objectRef<MutationResultShape>("CatalogMutationResult")
  .implement({
    description: "Identity of the catalog row written by a staff mutation.",
    fields: (t) => ({ id: t.exposeString("id") }),
  })

const SkillListInput = builder.inputType("SkillListInput", {
  fields: (t) => ({ values: t.stringList({ required: true }) }),
})

const ResourceTypeListInput = builder.inputType("ResourceTypeListInput", {
  fields: (t) => ({ values: t.stringList({ required: true }) }),
})

const OpenWindowInput = builder.inputType("OpenWindowInput", {
  fields: (t) => ({
    start: t.string({ required: true }),
    end: t.string({ required: true }),
  }),
})

const ServiceInput = builder.inputType("ServiceInput", {
  fields: (t) => ({
    id: t.string({ required: false }),
    name: t.string({ required: true }),
    description: t.string({ required: true }),
    durationMinutes: t.int({ required: true }),
    bufferBeforeMinutes: t.int({ required: true }),
    bufferAfterMinutes: t.int({ required: true }),
    holdingDays: t.int({ required: true }),
    requiredSkills: t.field({ type: SkillListInput, required: true }),
    requiredResourceTypes: t.field({ type: ResourceTypeListInput, required: true }),
    enabled: t.boolean({ required: true }),
  }),
})

const ProviderInput = builder.inputType("ProviderInput", {
  fields: (t) => ({
    id: t.string({ required: false }),
    name: t.string({ required: true }),
    skills: t.field({ type: SkillListInput, required: true }),
    enabled: t.boolean({ required: true }),
  }),
})

const ResourceInput = builder.inputType("ResourceInput", {
  fields: (t) => ({
    id: t.string({ required: false }),
    name: t.string({ required: true }),
    type: t.string({ required: true }),
    enabled: t.boolean({ required: true }),
  }),
})

const BusinessHoursInput = builder.inputType("BusinessHoursInput", {
  fields: (t) => ({
    id: t.string({ required: false }),
    weekday: t.int({ required: true }),
    windows: t.field({ type: [OpenWindowInput], required: true }),
  }),
})

const ClosureInput = builder.inputType("ClosureInput", {
  fields: (t) => ({
    id: t.string({ required: false }),
    date: t.string({ required: true }),
    reason: t.string({ required: true }),
  }),
})

const ProviderAbsenceInput = builder.inputType("ProviderAbsenceInput", {
  fields: (t) => ({
    id: t.string({ required: false }),
    providerId: t.string({ required: true }),
    start: t.string({ required: true }),
    end: t.string({ required: true }),
    reason: t.string({ required: true }),
  }),
})

const decodeOrRefuse = <E, R>(
  entity: InvalidCatalogInputError["entity"],
  schema: Schema.Schema<E, R>,
  raw: unknown,
): E => {
  const r = Schema.decodeUnknownEither(schema)(raw)
  if (r._tag === "Right") return r.right
  throw liftDomainError(new InvalidCatalogInputError({ entity, reason: summarizeParse(r.left) }))
}

/* -------------------------------------------------------------------------- */
/* Mutation registration                                                       */
/* -------------------------------------------------------------------------- */

builder.mutationFields((t) => ({
  saveService: t.field({
    type: MutationResultType,
    errors: { types: [BookingError] },
    description: "Upsert a Service. Requires StaffCapability with `manage_catalog`.",
    args: { input: t.arg({ type: ServiceInput, required: true }) },
    resolve: async (_root, { input }, ctx) => {
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

  deleteService: t.field({
    type: MutationResultType,
    errors: { types: [BookingError] },
    description: "Delete a Service by id. Requires StaffCapability with `manage_catalog`.",
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_root, { id }, ctx) => {
      requireStaffScope(ctx.request, "manage_catalog")
      const decoded = decodeOrRefuse("service", ServiceSchema.fields.id, id)
      await runCatalog(ctx.env, (cat) => cat.services.delete(decoded))
      return { id }
    },
  }),

  saveProvider: t.field({
    type: MutationResultType,
    errors: { types: [BookingError] },
    description: "Upsert a Provider. Requires StaffCapability with `manage_catalog`.",
    args: { input: t.arg({ type: ProviderInput, required: true }) },
    resolve: async (_root, { input }, ctx) => {
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

  deleteProvider: t.field({
    type: MutationResultType,
    errors: { types: [BookingError] },
    description: "Delete a Provider by id. Requires StaffCapability with `manage_catalog`.",
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_root, { id }, ctx) => {
      requireStaffScope(ctx.request, "manage_catalog")
      const decoded = decodeOrRefuse("provider", ProviderSchema.fields.id, id)
      await runCatalog(ctx.env, (cat) => cat.providers.delete(decoded))
      return { id }
    },
  }),

  saveResource: t.field({
    type: MutationResultType,
    errors: { types: [BookingError] },
    description: "Upsert a Resource. Requires StaffCapability with `manage_catalog`.",
    args: { input: t.arg({ type: ResourceInput, required: true }) },
    resolve: async (_root, { input }, ctx) => {
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

  deleteResource: t.field({
    type: MutationResultType,
    errors: { types: [BookingError] },
    description: "Delete a Resource by id. Requires StaffCapability with `manage_catalog`.",
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_root, { id }, ctx) => {
      requireStaffScope(ctx.request, "manage_catalog")
      const decoded = decodeOrRefuse("resource", ResourceSchema.fields.id, id)
      await runCatalog(ctx.env, (cat) => cat.resources.delete(decoded))
      return { id }
    },
  }),

  saveBusinessHours: t.field({
    type: MutationResultType,
    errors: { types: [BookingError] },
    description: "Upsert a BusinessHours row. Requires StaffCapability with `manage_catalog`.",
    args: { input: t.arg({ type: BusinessHoursInput, required: true }) },
    resolve: async (_root, { input }, ctx) => {
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

  deleteBusinessHours: t.field({
    type: MutationResultType,
    errors: { types: [BookingError] },
    description:
      "Delete a BusinessHours row by id. Requires StaffCapability with `manage_catalog`.",
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_root, { id }, ctx) => {
      requireStaffScope(ctx.request, "manage_catalog")
      const decoded = decodeOrRefuse("businessHours", BusinessHoursSchema.fields.id, id)
      await runCatalog(ctx.env, (cat) => cat.businessHours.delete(decoded))
      return { id }
    },
  }),

  saveClosure: t.field({
    type: MutationResultType,
    errors: { types: [BookingError] },
    description: "Upsert a Closure. Requires StaffCapability with `manage_catalog`.",
    args: { input: t.arg({ type: ClosureInput, required: true }) },
    resolve: async (_root, { input }, ctx) => {
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

  deleteClosure: t.field({
    type: MutationResultType,
    errors: { types: [BookingError] },
    description: "Delete a Closure by id. Requires StaffCapability with `manage_catalog`.",
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_root, { id }, ctx) => {
      requireStaffScope(ctx.request, "manage_catalog")
      const decoded = decodeOrRefuse("closure", ClosureSchema.fields.id, id)
      await runCatalog(ctx.env, (cat) => cat.closures.delete(decoded))
      return { id }
    },
  }),

  saveProviderAbsence: t.field({
    type: MutationResultType,
    errors: { types: [BookingError] },
    description: "Upsert a ProviderAbsence. Requires StaffCapability with `manage_catalog`.",
    args: { input: t.arg({ type: ProviderAbsenceInput, required: true }) },
    resolve: async (_root, { input }, ctx) => {
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

  deleteProviderAbsence: t.field({
    type: MutationResultType,
    errors: { types: [BookingError] },
    description: "Delete a ProviderAbsence by id. Requires StaffCapability with `manage_catalog`.",
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_root, { id }, ctx) => {
      requireStaffScope(ctx.request, "manage_catalog")
      const decoded = decodeOrRefuse("providerAbsence", ProviderAbsenceSchema.fields.id, id)
      await runCatalog(ctx.env, (cat) => cat.providerAbsences.delete(decoded))
      return { id }
    },
  }),
}))
