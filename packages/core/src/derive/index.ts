import { Schema } from "effect"
import type { Arbitrary as FCArbitrary } from "fast-check"
import { fold, fromSchemaAst, toSqlCheck } from "./algebra.js"

/**
 * Phase 0.7-β3 derive helpers — Effect Schema as the single source of
 * truth for the project's secondary surfaces. Phase 3 (BI Schema-
 * Predicate Algebra, ADR-0042 draft) re-grounds the SQL CHECK
 * extraction on a generic predicate fold (see `./algebra.ts`); this
 * file now hosts only the public surface and the Pothos-layer
 * disclaimer below.
 *
 * `schemaToArbitrary` lifts a Schema into a fast-check `Arbitrary`,
 * threading through Effect 4's native `Schema.toArbitrary`. Call sites
 * import this project alias rather than the upstream symbol so a
 * future Effect rename is one-line away.
 *
 * `schemaToCheckConstraint` projects the Schema's `isPattern`
 * annotations onto a SQLite `REGEXP` CHECK clause by folding the
 * predicate tree extracted from `schema.ast`. Schemas with no
 * recognised constraint surface `null`; the caller decides whether
 * to fall back to a column-level NOT NULL.
 *
 * Pothos `objectRef` derivation (the third planned helper) lives in
 * `apps/default/src/server/graphql/derive.ts` because Pothos is an
 * adapter-layer dependency, not a domain dependency — pulling it
 * into `@booking/core` would violate ADR-0036's "Schema as source of
 * truth, codec adapters at the boundary" rule.
 */

/**
 * Lift a Schema into a fast-check `Arbitrary`. Used by tests and the
 * property-test suite to derive sample generators from the boundary
 * schema instead of hand-rolling fixtures.
 *
 * The `unknown` cast bridges the upstream `FastCheck.Arbitrary` (the
 * version Effect re-exports) and the project's own pinned
 * `fast-check` major. Both runtimes accept the produced value because
 * the surface API (`fc.assert` / `fc.property`) is stable across the
 * bump; the cast lives in this single helper so the day Effect's
 * pinning matches ours, the cast disappears in one place.
 */
export const schemaToArbitrary = <S extends Schema.Top>(s: S): FCArbitrary<S["Type"]> =>
  Schema.toArbitrary(s)

/**
 * Render a SQLite CHECK constraint clause from a Schema, suitable for
 * appending to a Drizzle column definition or hand-written DDL.
 * Returns `null` when the schema does not advertise a recognised
 * constraint — the column then relies on application-level decode
 * for shape validation.
 *
 * Implemented as `fromSchemaAst → fold(toSqlCheck)`. Adding a new
 * constraint kind (e.g. length / range) is one entry in
 * `algebra.ts:fromCheck` plus the corresponding `PredicateAlgebra`
 * arm; this caller does not change.
 */
export const schemaToCheckConstraint = (schema: Schema.Top, columnName: string): string | null =>
  fold(toSqlCheck(columnName))(fromSchemaAst(schema.ast))

/**
 * Twin-functor projections — ADR-0041 / Phase 3 PR#7-#8. Each lifts
 * the same Schema source category to a different target artefact
 * (GraphQL types live in `apps/default` because Pothos is an
 * adapter-layer dep; OpenAPI schemas are runtime-agnostic and ship
 * from `packages/core`).
 */
export {
  type DeriveOpenAPIOptions,
  type OpenAPISchemaObject,
  schemaToOpenAPISchema,
} from "./openapi.js"
