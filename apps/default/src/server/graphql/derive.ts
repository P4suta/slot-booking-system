import type { Schema, SchemaAST } from "effect"
import {
  GraphQLBoolean,
  GraphQLEnumType,
  GraphQLFloat,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  type GraphQLOutputType,
  GraphQLString,
} from "graphql"

/**
 * Pure functor `Schema → GraphQLOutputType`.
 *
 * Twin of `derive/openapi.ts` (Phase 3 PR#8) — both consume the same
 * Effect Schema source category. This module gives `apps/default`'s
 * GraphQL adapter the on-ramp to derive `GraphQLObjectType` instances
 * from `Schema.Codec.Encoded<…>` rather than spelling out every field
 * twice in Pothos.
 *
 * Coverage matches the Schema variants the booking domain currently
 * exposes through GraphQL: scalar leaves (`String` / `Number` /
 * `Boolean` / `Literal`), `Arrays` (lift to `GraphQLList`), `Objects`
 * (lift to `GraphQLObjectType`), and `Union` of string `Literal`s
 * (lift to `GraphQLEnumType`). `Schema.brand` is transparent — the
 * brand is a TypeScript phantom only and serialises as the underlying
 * scalar at the wire.
 *
 * Optional fields are unwrapped to non-required GraphQL fields; non-
 * optional ones wrap in `GraphQLNonNull`.
 *
 * The translator carries a `registry` so recursive / mutually-
 * referential schemas dedupe by name. Out of scope for the M16 land:
 * `Union` of structs (discriminated unions need a GraphQLUnionType
 * wrapper) — the booking GraphQL surface keeps unions in Pothos
 * territory until the migration (PR#7 M17–M19) lands. The functor as
 * committed is the foundation that future migration drives.
 *
 * Cross-validated by `derive/graphql.test.ts`: identity / composition
 * laws aren't directly meaningful for a non-endo functor, but
 * structural-equivalence checks against hand-rolled `GraphQLObjectType`
 * instances stand in.
 */

/**
 * Policy controlling whether `Object` property types are wrapped in
 * `GraphQLNonNull`. Default `"nullable"` matches the gold SDL emitted
 * by the Pothos baseline (every output field is nullable by default
 * unless explicitly annotated). `"nonNull"` is the strict-Schema
 * reading and is exposed for callers that already speak a non-null-
 * everywhere category. Lists keep their inner-element non-null wrap
 * either way (`[X!]` is the GraphQL idiom that mirrors
 * `Schema.Array(NonNullable)`).
 */
type FieldNullability = "nullable" | "nonNull"

export type DeriveOptions = {
  /** Required when the schema is a Struct without an inherent name. */
  readonly name?: string
  /** Optional dedupe registry shared across nested calls. */
  readonly registry?: Map<string, GraphQLObjectType>
  /** Defaults to `"nullable"` (gold-SDL byte-equal policy). */
  readonly fieldNullability?: FieldNullability
}

const stringLiteralValues = (ast: SchemaAST.AST): readonly string[] | undefined => {
  if (ast._tag !== "Union") return undefined
  const out: string[] = []
  const types = (ast as unknown as { readonly types: readonly SchemaAST.AST[] }).types
  for (const member of types) {
    if (member._tag !== "Literal") return undefined
    const lit = (member as unknown as { readonly literal: unknown }).literal
    if (typeof lit !== "string") return undefined
    out.push(lit)
  }
  return out.length > 0 ? out : undefined
}

const enumFromLiterals = (name: string, literals: readonly string[]): GraphQLEnumType =>
  new GraphQLEnumType({
    name,
    values: Object.fromEntries(literals.map((v) => [v, { value: v }])),
  })

const isObjects = (
  ast: SchemaAST.AST,
): ast is SchemaAST.AST & { readonly propertySignatures: readonly SchemaAST.PropertySignature[] } =>
  ast._tag === "Objects"

const isArrays = (
  ast: SchemaAST.AST,
): ast is SchemaAST.AST & {
  readonly elements: readonly SchemaAST.AST[]
  readonly rest: readonly SchemaAST.AST[]
} => ast._tag === "Arrays"

/**
 * Walk a `SchemaAST.AST` to a `GraphQLOutputType`. Returns the bare
 * type without `GraphQLNonNull` wrapping; field nullability is
 * applied at the field level by the policy parameter.
 */
const astToOutputType = (
  ast: SchemaAST.AST,
  registry: Map<string, GraphQLObjectType>,
  policy: FieldNullability,
  hint?: string,
): GraphQLOutputType => {
  switch (ast._tag) {
    case "String":
    case "Literal":
      return GraphQLString
    case "Number":
      return GraphQLFloat
    case "Boolean":
      return GraphQLBoolean
    default:
      break
  }

  const literals = stringLiteralValues(ast)
  if (literals !== undefined && hint !== undefined) {
    return enumFromLiterals(hint, literals)
  }

  if (isArrays(ast)) {
    const rest = ast.rest[0]
    if (rest !== undefined) {
      // List-element non-null wrapping is preserved regardless of
      // `policy`: `[X!]` is the GraphQL idiom that mirrors a
      // `Schema.Array(NonNullable<X>)` wire shape — switching it off
      // would drop information the schema source provides.
      return new GraphQLList(new GraphQLNonNull(astToOutputType(rest, registry, policy)))
    }
  }

  if (isObjects(ast)) {
    if (hint !== undefined) {
      const cached = registry.get(hint)
      if (cached !== undefined) return cached
    }
    const placeholder = new GraphQLObjectType({
      name: hint ?? "AnonymousStruct",
      fields: () => {
        const out: Record<string, { type: GraphQLOutputType }> = {}
        for (const prop of ast.propertySignatures) {
          if (typeof prop.name !== "string") continue
          const inner = astToOutputType(prop.type, registry, policy)
          out[prop.name] =
            policy === "nonNull" ? { type: new GraphQLNonNull(inner) } : { type: inner }
        }
        return out
      },
    })
    if (hint !== undefined) registry.set(hint, placeholder)
    return placeholder
  }

  return GraphQLString
}

/**
 * Top-level entry point. Lift an Effect `Schema.Codec` to a
 * `GraphQLObjectType` (or scalar). Caller supplies `name` for any
 * schema that doesn't carry an inherent identifier, and optionally a
 * `registry` to dedupe across multiple calls. The `fieldNullability`
 * policy defaults to `"nullable"` — the gold-SDL byte-equal posture
 * inherited from the Pothos baseline (`apps/default/schema.graphql`).
 * Pass `"nonNull"` for callers that already speak a non-null-by-
 * default category and want strict-Schema reading.
 */
export const schemaToGraphQLOutputType = (
  schema: Schema.Top,
  options: DeriveOptions = {},
): GraphQLOutputType => {
  const registry = options.registry ?? new Map<string, GraphQLObjectType>()
  const policy = options.fieldNullability ?? "nullable"
  return astToOutputType(schema.ast, registry, policy, options.name)
}
