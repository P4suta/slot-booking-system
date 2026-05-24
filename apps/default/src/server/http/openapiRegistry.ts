import { JsonSchema, Schema } from "effect"
import {
  ByHandleQuerySchema,
  CallBatchBodySchema,
  CallNextBodySchema,
  CallSpecificBodySchema,
  CancelBodySchema,
  IssueTicketBodySchema,
  MyTicketQuerySchema,
  PushSubscriptionBodySchema,
  PushSubscriptionDeleteQuerySchema,
  RescheduleBodySchema,
  SlotsQuerySchema,
  StaffCancelBodySchema,
} from "./boundarySchemas.js"
import {
  WireIssueTicketMergedEnvelopeSchema,
  WireProjectionEntrySchema,
  WireTicketEnvelopeSchema,
  WireTicketSchema,
} from "./responseSchemas.js"

/**
 * Single registry of every Effect-Schema boundary surface the HTTP
 * router decodes through. The map is the canonical input to
 * `openapiDerive` (ADR-0078 foundation step) and to any
 * future drift test that wants to enumerate "every wire-shape the
 * router touches".
 *
 * Entries cover both request bodies (POST) and query schemas (GET
 * / DELETE) — the call site distinguishes by HTTP verb in
 * `openapi.ts`. The registry name is opaque; pick stable names so
 * the derived `$ref` / component identifiers can lean on them.
 *
 * Adding a new boundary surface is a 1-line edit here in addition
 * to the schema declaration in `boundarySchemas.ts` and the route
 * handler in `router.ts` — the lint gate at the bottom of this
 * file plus the snapshot test wired off `openapiDeriveSnapshot`
 * catch the drift.
 */
export const boundaryRegistry = {
  IssueTicketBody: IssueTicketBodySchema,
  CallNextBody: CallNextBodySchema,
  CallSpecificBody: CallSpecificBodySchema,
  CallBatchBody: CallBatchBodySchema,
  MyTicketQuery: MyTicketQuerySchema,
  ByHandleQuery: ByHandleQuerySchema,
  RescheduleBody: RescheduleBodySchema,
  CancelBody: CancelBodySchema,
  StaffCancelBody: StaffCancelBodySchema,
  PushSubscriptionBody: PushSubscriptionBodySchema,
  PushSubscriptionDeleteQuery: PushSubscriptionDeleteQuerySchema,
  SlotsQuery: SlotsQuerySchema,
} as const

export type BoundaryRegistryKey = keyof typeof boundaryRegistry

/**
 * Response-side wire registry (ADR-0085). Companion to
 * `boundaryRegistry`; the same `Schema.toJsonSchemaDocument` +
 * `JsonSchema.toMultiDocumentOpenApi3_1` pipeline turns these
 * Effect Schemas into OpenAPI 3.1 component schemas. The
 * `responseSchemas.ts` Wire variants are intentionally decoupled
 * from the domain `Ticket` union (see that file for the dedup-bug
 * rationale); a property test pins drift between domain ↔ wire.
 */
const responseRegistry = {
  Ticket: WireTicketSchema,
  ProjectionEntry: WireProjectionEntrySchema,
  TicketEnvelope: WireTicketEnvelopeSchema,
  IssueTicketMergedEnvelope: WireIssueTicketMergedEnvelopeSchema,
} as const

export type ResponseRegistryKey = keyof typeof responseRegistry

/**
 * Derive the JSON Schema document for one boundary-registry entry.
 * Returns the `Schema.toJsonSchemaDocument` output (draft-2020-12);
 * the `JsonSchema` namespace's `fromSchemaOpenApi3_1` adapter can
 * lift it to OpenAPI 3.1 if the caller needs that specific dialect.
 *
 * The function is the single point where `Schema.toJsonSchemaDocument`
 * is invoked on a boundary schema — keep it that way so future
 * boundary-spec drift fixes have a single seam.
 */
export const deriveBoundaryJsonSchema = (key: BoundaryRegistryKey) =>
  Schema.toJsonSchemaDocument(boundaryRegistry[key])

/**
 * Output of `buildOpenApiBundle()`. Carries the per-entry OpenAPI 3.1
 * schemas (refs rewritten to `#/components/schemas/...`) and the
 * shared `definitions` map suitable to splat into the openapi
 * document's `components.schemas` slot.
 */
export type OpenApiBundle = {
  readonly bodySchemasByKey: Readonly<Record<BoundaryRegistryKey, JsonSchema.JsonSchema>>
  readonly responseSchemasByKey: Readonly<Record<ResponseRegistryKey, JsonSchema.JsonSchema>>
  readonly components: Readonly<Record<string, JsonSchema.JsonSchema>>
}

/**
 * Convert every registry entry's `Schema.toJsonSchemaDocument` output
 * into OpenAPI 3.1 by batching them through
 * `JsonSchema.toMultiDocumentOpenApi3_1`. The conversion rewrites
 * `#/$defs/X` → `#/components/schemas/X` and unions every entry's
 * `definitions` into one map.
 *
 * Both boundary (request / query) and response registries are fed
 * through one MultiDocument call so any shared `$defs` (e.g.
 * `Instant`) lift into a single `components.schemas` slot.
 *
 * Memoise — the conversion is pure and the inputs are static; calling
 * once at module load avoids repeated AST walks on every request to
 * `/api/v1/openapi.json`.
 */
let cachedBundle: OpenApiBundle | undefined

export const buildOpenApiBundle = (): OpenApiBundle => {
  if (cachedBundle !== undefined) return cachedBundle
  const boundaryKeys = Object.keys(boundaryRegistry) as readonly BoundaryRegistryKey[]
  const responseKeys = Object.keys(responseRegistry) as readonly ResponseRegistryKey[]
  // Order matters — we slice the converted schemas back into
  // their per-registry maps by index below.
  const boundaryDrafts = boundaryKeys.map((k) => deriveBoundaryJsonSchema(k))
  const responseDrafts = responseKeys.map((k) => Schema.toJsonSchemaDocument(responseRegistry[k]))
  const allDrafts = [...boundaryDrafts, ...responseDrafts]
  // `MultiDocument.schemas` is typed as a non-empty tuple. Both
  // registries are non-empty by construction; the routerRegistry
  // and openapiRegistry tests pin their entry counts.
  const schemas = allDrafts.map((d) => d.schema) as unknown as readonly [
    JsonSchema.JsonSchema,
    ...JsonSchema.JsonSchema[],
  ]
  const draftMulti: JsonSchema.MultiDocument<"draft-2020-12"> = {
    dialect: "draft-2020-12",
    schemas,
    definitions: Object.assign({}, ...allDrafts.map((d) => d.definitions)) as Record<
      string,
      JsonSchema.JsonSchema
    >,
  }
  const openapiMulti = JsonSchema.toMultiDocumentOpenApi3_1(draftMulti)
  const bodySchemasByKey = Object.fromEntries(
    boundaryKeys.map((k, i) => [k, openapiMulti.schemas[i]] as const),
  ) as Record<BoundaryRegistryKey, JsonSchema.JsonSchema>
  const responseSchemasByKey = Object.fromEntries(
    responseKeys.map((k, i) => [k, openapiMulti.schemas[boundaryKeys.length + i]] as const),
  ) as Record<ResponseRegistryKey, JsonSchema.JsonSchema>
  cachedBundle = {
    bodySchemasByKey,
    responseSchemasByKey,
    components: openapiMulti.definitions,
  }
  return cachedBundle
}

/** Shorthand: derived OpenAPI 3.1 schema for a single boundary-registry entry. */
export const bodySchemaFor = (key: BoundaryRegistryKey): JsonSchema.JsonSchema =>
  buildOpenApiBundle().bodySchemasByKey[key]

/** Shorthand: derived OpenAPI 3.1 schema for a single response-registry entry. */
export const responseSchemaFor = (key: ResponseRegistryKey): JsonSchema.JsonSchema =>
  buildOpenApiBundle().responseSchemasByKey[key]
