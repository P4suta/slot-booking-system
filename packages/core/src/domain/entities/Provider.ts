import { Schema } from "effect"
import * as Identifiable from "../typeclass/Identifiable.js"
import * as Satisfier from "../typeclass/Satisfier.js"
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

export const providerIdentifiable: Identifiable.Identifiable<Provider> = Identifiable.make(
  (p) => p.id,
)

/** Set-inclusion satisfier: a Provider's `skills` ⊇ the requested set. */
export const providerSkillSatisfier: Satisfier.Satisfier<
  Provider,
  ReadonlySet<Skill>
> = Satisfier.make((p, required) => Satisfier.isSubsetOf(required, p.skills))

/** True iff the provider holds every skill the service requires. */
export const providerSatisfies = (p: Provider, required: ReadonlySet<Skill>): boolean =>
  providerSkillSatisfier.satisfies(p, required)
