import { Schema } from "effect"
import { ProviderIdSchema } from "../types/EntityId.js"
import type { Skill } from "../value-objects/Skill.js"
import { SkillSchema } from "../value-objects/Skill.js"

export const ProviderSchema = Schema.Struct({
  id: ProviderIdSchema,
  name: Schema.String,
  skills: Schema.ReadonlySet(SkillSchema),
  enabled: Schema.Boolean,
})
export type Provider = Schema.Schema.Type<typeof ProviderSchema>

/** True iff the provider holds every skill the service requires. */
export const providerSatisfies = (p: Provider, required: ReadonlySet<Skill>): boolean => {
  for (const s of required) {
    if (!p.skills.has(s)) return false
  }
  return true
}
