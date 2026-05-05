import { Arbitrary, type Schema, SchemaAST } from "effect"
import type { Arbitrary as FCArbitrary } from "fast-check"

/**
 * Phase 0.7-β3 derive helpers — Effect Schema as the single source of
 * truth for the project's secondary surfaces.
 *
 * `schemaToArbitrary` is a thin alias over Effect's `Arbitrary.make`
 * (effect 3.10+). The helper exists so call sites import the
 * project's vocabulary rather than the Effect submodule path; if a
 * future Effect release renames or restructures the API, the swap
 * happens in this one file.
 *
 * `schemaToCheckConstraint` extracts a branded string Schema's regex
 * pattern (when present) and renders a SQLite-compatible CHECK
 * clause via the `regexp` virtual function. Schemas without a
 * pattern annotation return `null`; the caller decides whether to
 * fall back to a column-level NOT NULL only.
 *
 * Pothos `objectRef` derivation (the third planned helper in this
 * module) lives in `apps/default/src/server/graphql/derive.ts`
 * (Phase 0.7-β4) because Pothos is an adapter-layer dependency, not a
 * domain dependency — pulling it into `@booking/core` would violate
 * ADR-0036's "Schema as source of truth, codec adapters at the
 * boundary" rule.
 */

/**
 * Lift an Effect Schema into a fast-check `Arbitrary`. Used by tests
 * and the property-test suite to derive sample generators from the
 * boundary schema instead of hand-rolling fixtures.
 *
 * Note (2026-05): `effect` 3.21 still pins `fast-check@^3` while this
 * project tracks `fast-check@^4` (the runtime APIs we use are stable
 * across the major bump — `fc.assert`, `fc.property`, `fc.constant`).
 * The `unknown` cast bridges the two declaration files; both
 * runtimes accept the produced `Arbitrary` because the underlying
 * shape is unchanged. The cast lives in this single helper so the
 * day Effect upgrades, the cast disappears in one place.
 */
export const schemaToArbitrary = <A, I, R>(s: Schema.Schema<A, I, R>): FCArbitrary<A> =>
  Arbitrary.make(s) as unknown as FCArbitrary<A>

/**
 * Walk a Schema AST to extract the first regex pattern annotation
 * found on a `Refinement`/`Filter` node. Returns `null` when no
 * pattern is present — the schema is then responsible for its own
 * validation through `decode` and the SQL layer can omit the CHECK.
 */
const hasStringPattern = (raw: unknown): raw is { readonly pattern: string } =>
  typeof raw === "object" &&
  raw !== null &&
  "pattern" in raw &&
  typeof (raw as { readonly pattern: unknown }).pattern === "string"

const extractPattern = (ast: SchemaAST.AST): string | null => {
  const visit = (node: SchemaAST.AST): string | null => {
    if (node._tag === "Refinement") {
      const ann = SchemaAST.getJSONSchemaAnnotation(node)
      if (ann._tag === "Some" && hasStringPattern(ann.value)) {
        return ann.value.pattern
      }
      return visit(node.from)
    }
    if (node._tag === "Transformation") return visit(node.from)
    return null
  }
  return visit(ast)
}

/**
 * Render a SQLite CHECK constraint clause from a Schema, suitable for
 * appending to a Drizzle column definition or a hand-written DDL.
 * Returns `null` when the schema does not advertise a regex pattern
 * — the column then relies on application-level decode for shape
 * validation.
 *
 * The emitted clause uses SQLite's `regexp` operator, which the
 * Cloudflare DO SQLite build supports out of the box. Single quotes
 * inside the pattern are doubled to keep the SQL well-formed.
 */
export const schemaToCheckConstraint = <A, I, R>(
  schema: Schema.Schema<A, I, R>,
  columnName: string,
): string | null => {
  const pattern = extractPattern(schema.ast)
  if (pattern === null) return null
  const escaped = pattern.replace(/'/g, "''")
  return `${columnName} REGEXP '${escaped}'`
}
