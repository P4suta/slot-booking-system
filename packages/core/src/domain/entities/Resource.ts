import type { ResourceId } from "../types/EntityId.js"
import type { ResourceType } from "../value-objects/ResourceType.js"

/**
 * Physical resource (workspace, storage rack, …). Capacity is expressed
 * by registering N separate Resources of the same `type` (ADR-0008,
 * ADR-0012). There is no `capacity: number` field — every Resource is
 * one indivisible unit.
 */
export type Resource = {
  readonly id: ResourceId
  readonly name: string
  readonly type: ResourceType
  readonly enabled: boolean
}
