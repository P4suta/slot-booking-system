import { Either } from "effect"
import { type DomainError, InvalidSkill } from "../errors/DomainError.js"
import type { Brand } from "../types/Brand.js"

/**
 * Skill that a Provider may possess and a Service may require. Lowercase
 * snake-case ASCII; max 40 chars. Industry-agnostic — concrete skill
 * names live in deployment configuration, never in the core.
 */
export type Skill = Brand<string, "Skill">

const SKILL_PATTERN = /^[a-z][a-z0-9_]{0,39}$/

export const parseSkill = (raw: string): Either.Either<Skill, DomainError> =>
  SKILL_PATTERN.test(raw)
    ? Either.right(raw as Skill)
    : Either.left(InvalidSkill(`skill must match ${SKILL_PATTERN}`))
