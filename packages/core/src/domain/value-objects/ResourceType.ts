import { Either } from "effect"
import { type DomainError, InvalidResourceTypeError } from "../errors/Errors.js"
import type { Brand } from "../types/Brand.js"

/**
 * Logical type of a Resource — `workspace`, `storage`, `chair`, …
 * Lowercase snake-case ASCII; max 40 chars. Concrete type names live
 * in the deployment, never in `packages/core`.
 */
export type ResourceType = Brand<string, "ResourceType">

const RESOURCE_TYPE_PATTERN = /^[a-z][a-z0-9_]{0,39}$/

export const parseResourceType = (raw: string): Either.Either<ResourceType, DomainError> =>
  RESOURCE_TYPE_PATTERN.test(raw)
    ? Either.right(raw as ResourceType)
    : Either.left(
        new InvalidResourceTypeError({
          reason: `resource type must match ${RESOURCE_TYPE_PATTERN}`,
        }),
      )
