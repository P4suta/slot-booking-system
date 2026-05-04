import type { ProviderId } from "../types/EntityId.js"
import type { Skill } from "../value-objects/Skill.js"

export type Provider = {
  readonly id: ProviderId
  readonly name: string
  readonly skills: ReadonlySet<Skill>
  readonly enabled: boolean
}

/** True iff the provider holds every skill the service requires. */
export const providerSatisfies = (p: Provider, required: ReadonlySet<Skill>): boolean => {
  for (const s of required) {
    if (!p.skills.has(s)) return false
  }
  return true
}
