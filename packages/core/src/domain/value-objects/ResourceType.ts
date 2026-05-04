import { Either, Schema } from "effect"
import { type DomainError, InvalidResourceTypeError } from "../errors/Errors.js"
import { summarizeParse } from "../errors/fromParseError.js"

/**
 * Logical type of a Resource — `workspace`, `storage`, `chair`, …
 * Lowercase snake-case ASCII; max 40 chars. Concrete type names live
 * in the deployment, never in `packages/core`.
 */
export const ResourceTypeSchema = Schema.String.pipe(
  Schema.pattern(/^[a-z][a-z0-9_]{0,39}$/),
  Schema.brand("ResourceType"),
)
export type ResourceType = Schema.Schema.Type<typeof ResourceTypeSchema>

const decode = Schema.decodeUnknownEither(ResourceTypeSchema)

export const parseResourceType = (raw: string): Either.Either<ResourceType, DomainError> =>
  Either.mapLeft(decode(raw), (e) => new InvalidResourceTypeError({ reason: summarizeParse(e) }))
