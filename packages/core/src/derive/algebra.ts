import type { AST, Check } from "effect/SchemaAST"

/**
 * Phase 3 / BI Schema-Predicate Algebra (ADR-0042 draft).
 *
 * `derive/index.ts` previously walked a Schema's `Checks` tuple
 * looking for a single annotation (`isPattern`) and projected it onto
 * one consumer (a SQL CHECK clause). The walker pattern doesn't scale
 * past one annotation × one projection: every new combination
 * duplicates the traversal.
 *
 * The fix is to reify the Schema's structural constraints as data —
 * a {@link Predicate} tree — and let multiple {@link PredicateAlgebra}
 * folds project the same tree onto different consumer surfaces (SQL
 * CHECK clause today, fast-check `Arbitrary` and runtime validator
 * tomorrow). The shape is an *initial* algebra (constructors return
 * data) rather than the *tagless-final* alternative; initial keeps
 * the tree inspectable for debugging at the cost of one allocation
 * per node.
 *
 * References — Bird & de Moor *Algebra of Programming* ch. 4
 * (catamorphisms over polynomial functors), Joyal's species when
 * extended with products.
 */

/* -------------------------------------------------------------------------- */
/* Predicate ADT                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Initial-encoded predicate tree. The leaf today is `Pattern`
 * (isPattern regex); combinators (`And` / `Or` / `Not`) compose
 * children, and `Always` is the algebra unit (no-op leaf used both
 * as identity for `And` and as the projection of an unrecognised
 * Schema check).
 *
 * The `T` parameter is phantom — it carries the value-shape the
 * predicate constrains so future leaves (e.g. `Length` for strings,
 * `Range` for numbers) can statically refuse to mix.
 */
export type Predicate<_T> =
  | { readonly _tag: "Pattern"; readonly regex: RegExp }
  | { readonly _tag: "And"; readonly children: readonly Predicate<_T>[] }
  | { readonly _tag: "Or"; readonly children: readonly Predicate<_T>[] }
  | { readonly _tag: "Not"; readonly child: Predicate<_T> }
  | { readonly _tag: "Always" }

/* -------------------------------------------------------------------------- */
/* Smart constructors                                                          */
/* -------------------------------------------------------------------------- */

export const pattern = <T>(regex: RegExp): Predicate<T> => ({ _tag: "Pattern", regex })

export const always = <T>(): Predicate<T> => ({ _tag: "Always" })

export const and = <T>(...children: readonly Predicate<T>[]): Predicate<T> => ({
  _tag: "And",
  children,
})

export const or = <T>(...children: readonly Predicate<T>[]): Predicate<T> => ({
  _tag: "Or",
  children,
})

export const not = <T>(child: Predicate<T>): Predicate<T> => ({ _tag: "Not", child })

/* -------------------------------------------------------------------------- */
/* F-algebra and catamorphism                                                  */
/* -------------------------------------------------------------------------- */

/**
 * F-algebra over `Predicate<T>`. Each method receives already-folded
 * children, so {@link fold} reduces the tree bottom-up in one pass.
 *
 * To add a new projection (e.g. `toArbitrary: PredicateAlgebra<T,
 * FCArbitrary<T>>`) declare an algebra implementing this interface;
 * the fold then walks the tree without further recursion in the
 * caller.
 */
export type PredicateAlgebra<_T, R> = {
  readonly Pattern: (regex: RegExp) => R
  readonly And: (children: readonly R[]) => R
  readonly Or: (children: readonly R[]) => R
  readonly Not: (child: R) => R
  readonly Always: () => R
}

/** Catamorphism over {@link Predicate}. */
export const fold =
  <T, R>(alg: PredicateAlgebra<T, R>) =>
  (p: Predicate<T>): R => {
    switch (p._tag) {
      case "Pattern":
        return alg.Pattern(p.regex)
      case "And":
        return alg.And(p.children.map(fold(alg)))
      case "Or":
        return alg.Or(p.children.map(fold(alg)))
      case "Not":
        return alg.Not(fold(alg)(p.child))
      case "Always":
        return alg.Always()
    }
  }

/* -------------------------------------------------------------------------- */
/* Schema → Predicate extraction                                               */
/* -------------------------------------------------------------------------- */

/**
 * Effect 4's `isPattern` annotation shape: `{ _tag: "isPattern",
 * regExp }` attached to a `Filter` node's `meta`. Recognising
 * additional annotations (isLength, isBetween) is a one-line addition
 * to {@link fromCheck}.
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

const fromCheck = <T>(check: Check<unknown>): Predicate<T> => {
  const meta = check.annotations?.meta
  if (isIsPatternMeta(meta)) return pattern(meta.regExp)
  return always()
}

/**
 * Lift a Schema AST's `Checks` tuple into a {@link Predicate} tree.
 * Multiple checks combine as `And`; an empty tuple folds to `Always`
 * (which projects to the projection-specific neutral element — `null`
 * for SQL, the unconstrained Arbitrary for fast-check, etc).
 */
export const fromSchemaAst = <T>(ast: AST): Predicate<T> => {
  if (ast.checks === undefined || ast.checks.length === 0) return always()
  const leaves = ast.checks.map((c) => fromCheck<T>(c as Check<unknown>))
  const [first] = leaves
  if (first !== undefined && leaves.length === 1) return first
  return and(...leaves)
}

/* -------------------------------------------------------------------------- */
/* Projection: SQL CHECK clause                                                */
/* -------------------------------------------------------------------------- */

const escapeSqlLiteral = (raw: string): string => raw.replace(/'/g, "''")

const conjunction =
  (op: "AND" | "OR") =>
  (children: readonly (string | null)[]): string | null => {
    const present = children.filter((c): c is string => c !== null)
    const [first] = present
    if (first === undefined) return null
    if (present.length === 1) return first
    return `(${present.join(` ${op} `)})`
  }

/**
 * Project a {@link Predicate} onto a SQLite CHECK clause anchored at
 * `column`. `null` means "no constraint" — the column relies on
 * application-level decode for shape validation.
 *
 * `Pattern(re)` emits `<column> REGEXP '<source>'` (single quotes
 * inside the literal are doubled, matching the SQLite quoting rule);
 * `Always` and empty `And`/`Or` collapse to `null` so they layer
 * cleanly inside larger composites.
 */
export const toSqlCheck = (column: string): PredicateAlgebra<string, string | null> => ({
  Pattern: (regex) => `${column} REGEXP '${escapeSqlLiteral(regex.source)}'`,
  And: conjunction("AND"),
  Or: conjunction("OR"),
  Not: (child) => (child === null ? null : `NOT (${child})`),
  Always: () => null,
})
