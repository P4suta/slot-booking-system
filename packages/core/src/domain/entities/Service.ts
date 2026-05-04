import type { ServiceId } from "../types/EntityId.js"
import type { Minutes } from "../value-objects/Duration.js"
import type { HoldingDays } from "../value-objects/HoldingDays.js"
import type { ResourceType } from "../value-objects/ResourceType.js"
import type { Skill } from "../value-objects/Skill.js"

/**
 * A unit of work the business offers. Industry-agnostic: the deployment
 * names ("パンク修理", "Hair Cut", …) live entirely in the deployment
 * UI/copy layer, never in `name` of a core test.
 *
 * `requiredSkills` and `requiredResourceTypes` use Set semantics — no
 * meaningful ordering, only membership. Iteration order is insertion
 * order; constructors that care about determinism canonicalise the
 * sets at construction time.
 */
export type Service = {
  readonly id: ServiceId
  readonly name: string
  readonly description: string
  readonly durationMinutes: Minutes
  readonly bufferBeforeMinutes: Minutes
  readonly bufferAfterMinutes: Minutes
  readonly holdingDays: HoldingDays
  readonly requiredSkills: ReadonlySet<Skill>
  readonly requiredResourceTypes: ReadonlySet<ResourceType>
  readonly enabled: boolean
}

/** Total time the Provider is occupied per booking, including buffers. */
export const totalProviderMinutes = (s: Service): number =>
  s.durationMinutes + s.bufferBeforeMinutes + s.bufferAfterMinutes
