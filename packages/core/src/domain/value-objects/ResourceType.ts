import { Result, Schema } from "effect"
import { type DomainError, InvalidResourceTypeError } from "../errors/Errors.js"
import { summarizeParse } from "../errors/fromParseError.js"

/**
 * Logical type of a Resource — `workspace`, `storage`, `chair`, …
 * Lowercase snake-case ASCII; max 40 chars. Concrete type names live
 * in the deployment, never in `packages/core`.
 */
export const ResourceTypeSchema = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9_]{0,39}$/),
).pipe(Schema.brand("ResourceType"))
export type ResourceType = Schema.Schema.Type<typeof ResourceTypeSchema>

const decode = Schema.decodeUnknownResult(ResourceTypeSchema)

export const parseResourceType = (raw: string): Result.Result<ResourceType, DomainError> =>
  Result.mapError(decode(raw), (e) => new InvalidResourceTypeError({ reason: summarizeParse(e) }))
