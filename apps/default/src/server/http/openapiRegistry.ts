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
  ReorderBodySchema,
  RescheduleBodySchema,
  SlotsQuerySchema,
  StaffCancelBodySchema,
} from "./boundarySchemas.js"

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
  ReorderBody: ReorderBodySchema,
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
  readonly schemasByKey: Readonly<Record<BoundaryRegistryKey, JsonSchema.JsonSchema>>
  readonly components: Readonly<Record<string, JsonSchema.JsonSchema>>
}

/**
 * Convert every registry entry's `Schema.toJsonSchemaDocument` output
 * into OpenAPI 3.1 by batching them through
 * `JsonSchema.toMultiDocumentOpenApi3_1`. The conversion rewrites
 * `#/$defs/X` → `#/components/schemas/X` and unions every entry's
 * `definitions` into one map.
 *
 * Memoise — the conversion is pure and the inputs are static; calling
 * once at module load avoids repeated AST walks on every request to
 * `/api/v1/openapi.json`.
 */
let cachedBundle: OpenApiBundle | undefined

export const buildOpenApiBundle = (): OpenApiBundle => {
  if (cachedBundle !== undefined) return cachedBundle
  const keys = Object.keys(boundaryRegistry) as readonly BoundaryRegistryKey[]
  // The MultiDocument input preserves entry ordering, so we can
  // match `openapi.schemas[i]` back to `keys[i]` after conversion.
  const draftDocs = keys.map((k) => deriveBoundaryJsonSchema(k))
  // `MultiDocument.schemas` is typed as a non-empty tuple; the
  // registry has 13 entries by construction (see `boundaryRegistry`
  // above + the count pin in `openapiRegistry.test.ts`), so this
  // assertion holds at compile time even though TS cannot see it.
  const schemas = draftDocs.map((d) => d.schema) as unknown as readonly [
    JsonSchema.JsonSchema,
    ...JsonSchema.JsonSchema[],
  ]
  const draftMulti: JsonSchema.MultiDocument<"draft-2020-12"> = {
    dialect: "draft-2020-12",
    schemas,
    definitions: Object.assign({}, ...draftDocs.map((d) => d.definitions)) as Record<
      string,
      JsonSchema.JsonSchema
    >,
  }
  const openapiMulti = JsonSchema.toMultiDocumentOpenApi3_1(draftMulti)
  const schemasByKey = Object.fromEntries(
    keys.map((k, i) => [k, openapiMulti.schemas[i]] as const),
  ) as Record<BoundaryRegistryKey, JsonSchema.JsonSchema>
  cachedBundle = {
    schemasByKey,
    components: openapiMulti.definitions,
  }
  return cachedBundle
}

/** Shorthand: derived OpenAPI 3.1 schema for a single registry entry. */
export const bodySchemaFor = (key: BoundaryRegistryKey): JsonSchema.JsonSchema =>
  buildOpenApiBundle().schemasByKey[key]
