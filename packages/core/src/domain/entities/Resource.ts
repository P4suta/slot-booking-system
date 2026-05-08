import { Schema } from "effect"
import * as Identifiable from "../typeclass/Identifiable.js"
import * as Satisfier from "../typeclass/Satisfier.js"
import { ResourceIdSchema } from "../types/EntityId.js"
import type { ResourceType } from "../value-objects/ResourceType.js"
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

export const resourceIdentifiable: Identifiable.Identifiable<Resource> = Identifiable.make(
  (r) => r.id,
)

/** Set-membership satisfier: the Resource's `type` ∈ the requested set. */
export const resourceTypeSatisfier: Satisfier.Satisfier<
  Resource,
  ReadonlySet<ResourceType>
> = Satisfier.make((r, requiredTypes) => requiredTypes.has(r.type))
