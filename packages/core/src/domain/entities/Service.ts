import { Schema } from "effect"
import { ServiceIdSchema } from "../types/EntityId.js"
import { MinutesSchema } from "../value-objects/Duration.js"
import { HoldingDaysSchema } from "../value-objects/HoldingDays.js"
import { ResourceTypeSchema } from "../value-objects/ResourceType.js"
import { SkillSchema } from "../value-objects/Skill.js"

/**
 * A unit of work the business offers. Industry-agnostic: the deployment
 * names live entirely in the deployment UI/copy layer, never in `name`
 * of a core test.
 *
 * `requiredSkills` and `requiredResourceTypes` use Set semantics — no
 * meaningful ordering, only membership. Iteration order is insertion
 * order; constructors that care about determinism canonicalise the
 * sets at construction time.
 */
export const ServiceSchema = Schema.Struct({
  id: ServiceIdSchema,
  name: Schema.String,
  description: Schema.String,
  durationMinutes: MinutesSchema,
  bufferBeforeMinutes: MinutesSchema,
  bufferAfterMinutes: MinutesSchema,
  holdingDays: HoldingDaysSchema,
  requiredSkills: Schema.ReadonlySet(SkillSchema),
  requiredResourceTypes: Schema.ReadonlySet(ResourceTypeSchema),
  enabled: Schema.Boolean,
})
export type Service = Schema.Schema.Type<typeof ServiceSchema>

/** Total time the Provider is occupied per booking, including buffers. */
export const totalProviderMinutes = (s: Service): number =>
  s.durationMinutes + s.bufferBeforeMinutes + s.bufferAfterMinutes
