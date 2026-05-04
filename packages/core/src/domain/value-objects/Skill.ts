import { Either, Schema } from "effect"
import { type DomainError, InvalidSkillError } from "../errors/Errors.js"
import { summarizeParse } from "../errors/fromParseError.js"

/**
 * Skill that a Provider may possess and a Service may require. Lowercase
 * snake-case ASCII; max 40 chars. Industry-agnostic — concrete skill
 * names live in deployment configuration, never in the core.
 */
export const SkillSchema = Schema.String.pipe(
  Schema.pattern(/^[a-z][a-z0-9_]{0,39}$/),
  Schema.brand("Skill"),
)
export type Skill = Schema.Schema.Type<typeof SkillSchema>

const decode = Schema.decodeUnknownEither(SkillSchema)

export const parseSkill = (raw: string): Either.Either<Skill, DomainError> =>
  Either.mapLeft(decode(raw), (e) => new InvalidSkillError({ reason: summarizeParse(e) }))
