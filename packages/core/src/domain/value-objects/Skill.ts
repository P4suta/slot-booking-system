import type { Schema } from "effect"
import { InvalidSkillError } from "../errors/Errors.js"
import { brandedString } from "./_brandedString.js"

/**
 * Skill that a Provider may possess and a Service may require. Lowercase
 * snake-case ASCII; max 40 chars. Industry-agnostic — concrete skill
 * names live in deployment configuration, never in the core.
 */
const skill = brandedString({
  brand: "Skill",
  pattern: /^[a-z][a-z0-9_]{0,39}$/,
  errorClass: InvalidSkillError,
})

export const SkillSchema = skill.schema
export type Skill = Schema.Schema.Type<typeof SkillSchema>

export const parseSkill = skill.parse
