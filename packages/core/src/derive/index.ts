import { Schema } from "effect"
import type { Arbitrary as FCArbitrary } from "fast-check"

/**
 * Lift a Schema into a fast-check `Arbitrary`. Tests and property
 * suites derive sample generators from the boundary schema instead
 * of hand-rolling fixtures.
 *
 * The `unknown`-free cast bridges Effect's re-exported FastCheck
 * Arbitrary and the project's pinned `fast-check` major; the surface
 * API (`fc.assert` / `fc.property`) is stable across the bump.
 */
export const schemaToArbitrary = <S extends Schema.Top>(s: S): FCArbitrary<S["Type"]> =>
  Schema.toArbitrary(s)

export {
  type DeriveOpenAPIOptions,
  type OpenAPISchemaObject,
  schemaToOpenAPISchema,
} from "./openapi.js"
