import { Schema } from "effect"
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
