import { Schema } from "effect"
import { ResourceIdSchema } from "../types/EntityId.js"
import { ResourceTypeSchema } from "../value-objects/ResourceType.js"

/**
 * Physical resource (workspace, storage rack, …). Capacity is expressed
 * by registering N separate Resources of the same `type` (ADR-0008,
 * ADR-0012). There is no `capacity: number` field — every Resource is
 * one indivisible unit.
 */
export const ResourceSchema = Schema.Struct({
  id: ResourceIdSchema,
  name: Schema.String,
  type: ResourceTypeSchema,
  enabled: Schema.Boolean,
})
export type Resource = Schema.Schema.Type<typeof ResourceSchema>
