import { Schema } from "effect"
import type { AST, Check } from "effect/SchemaAST"
import type { Arbitrary as FCArbitrary } from "fast-check"

/**
 * Phase 0.7-β3 derive helpers — Effect Schema as the single source of
 * truth for the project's secondary surfaces.
 *
 * `schemaToArbitrary` lifts a Schema into a fast-check `Arbitrary`,
 * threading through Effect 4's native `Schema.toArbitrary`. Call sites
 * import this project alias rather than the upstream symbol so a
 * future Effect rename is one-line away.
 *
 * `schemaToCheckConstraint` projects a regex `isPattern` annotation
 * onto a SQLite `REGEXP` CHECK clause. The walk is a one-pass
 * traversal over `ast.checks` (Effect 4 stores filters as a flat
 * `Checks` tuple at the node, not as nested `Refinement` AST nodes).
 * Schemas without an `isPattern` annotation surface `null`; the
 * caller decides whether to fall back to a column-level NOT NULL.
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
 * Internal shape of `isPattern`'s annotation `meta`. Effect 4 attaches
 * `{ _tag: "isPattern", regExp: RegExp }` to the `Filter` produced by
 * `Schema.isPattern(re)`. Schemas without that annotation expose no
 * regex, and the SQL projection is a no-op.
 */
type IsPatternMeta = {
  readonly _tag: "isPattern"
  readonly regExp: RegExp
}

const isIsPatternMeta = (meta: unknown): meta is IsPatternMeta =>
  typeof meta === "object" &&
  meta !== null &&
  "_tag" in meta &&
  (meta as { readonly _tag: unknown })._tag === "isPattern" &&
  "regExp" in meta &&
  (meta as { readonly regExp: unknown }).regExp instanceof RegExp

const patternFromCheck = (check: Check<unknown>): RegExp | null => {
  const meta = check.annotations?.meta
  return isIsPatternMeta(meta) ? meta.regExp : null
}

/**
 * Extract the first `isPattern` regex declared on a schema's check
 * tuple. The walk is shallow — Effect 4's `Checks` is a flat array
 * attached to the AST node itself, not a chain of nested AST kinds.
 */
const extractPattern = (ast: AST): RegExp | null => {
  if (ast.checks === undefined) return null
  for (const check of ast.checks) {
    const re = patternFromCheck(check as Check<unknown>)
    if (re !== null) return re
  }
  return null
}

/**
 * Render a SQLite CHECK constraint clause from a Schema, suitable for
 * appending to a Drizzle column definition or hand-written DDL.
 * Returns `null` when the schema does not advertise a regex pattern —
 * the column then relies on application-level decode for shape
 * validation.
 *
 * The emitted clause uses SQLite's `regexp` operator, which the
 * Cloudflare DO SQLite build supports out of the box. Single quotes
 * inside the pattern are doubled to keep the SQL well-formed.
 */
export const schemaToCheckConstraint = (schema: Schema.Top, columnName: string): string | null => {
  const re = extractPattern(schema.ast)
  if (re === null) return null
  const escaped = re.source.replace(/'/g, "''")
  return `${columnName} REGEXP '${escaped}'`
}
