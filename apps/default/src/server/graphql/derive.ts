import type { Schema, SchemaAST } from "effect"
import {
  GraphQLBoolean,
  GraphQLEnumType,
  GraphQLFloat,
  GraphQLInputObjectType,
  type GraphQLInputType,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  type GraphQLOutputType,
  type GraphQLScalarType,
  GraphQLString,
  GraphQLUnionType,
} from "graphql"

/**
 * Twin functors `Schema → GraphQLOutputType` (covariant) and
 * `Schema → GraphQLInputType` (covariant on the same source category
 * minus unions of structs — GraphQL forbids them in inputs). Both
 * walk `SchemaAST.AST` structurally and share leaf-level decisions
 * (scalar / brand / Int / String / Boolean / Literal / Array). The
 * recursion bifurcates on `Objects`: outputs land on
 * `GraphQLObjectType`, inputs on `GraphQLInputObjectType`.
 *
 * Coverage (PR#7 final):
 *
 * - Scalar leaves: `String`, `Number`, `Boolean`, `Literal`. The
 *   `Number` case walks `ast.checks` for the `isInt` filter
 *   annotation (`meta._tag === "isInt"`) and lifts to `GraphQLInt`
 *   when present, falling back to `GraphQLFloat`.
 * - Brand-aware scalars: `Schema.brand("PlainDate", ...)` etc. Pass
 *   `scalarRegistry: Map<string, GraphQLScalarType>` and any AST whose
 *   `annotations.brands` contains a registered identifier returns the
 *   pre-built scalar. Brand walks both `ast.annotations` and the
 *   last-check's annotations (Effect's `resolve` rule), so brands
 *   piped after a `check(...)` chain still surface.
 * - `Arrays` → `GraphQLList(GraphQLNonNull(...))` (list-element
 *   non-null wrap mirrors `Schema.Array(NonNullable)`).
 * - `Objects` → `GraphQLObjectType` (output) or
 *   `GraphQLInputObjectType` (input). Field nullability follows
 *   {@link FieldNullability} for outputs (`"schema-faithful"` reads
 *   `SchemaAST.isOptional(prop.type)`); inputs are always schema-
 *   faithful since GraphQL inputs have no concept of "always
 *   nullable".
 * - Union of string `Literal`s → `GraphQLEnumType` (named enums need
 *   a `hint`).
 * - Union of struct AST nodes (Effect `TaggedUnion` of
 *   `_tag`-discriminated cases) → `GraphQLUnionType`. The functor
 *   inspects `_tag` literal values on each member, names the union
 *   from the `hint`, and uses the discriminator at `resolveType` so
 *   graphql-js routes records to the right object arm.
 * - Recursive / mutually-referential structs dedupe through the
 *   `registry` so `printSchema` sees one declaration per name.
 *
 * Brand-aware scalar / `Schema.Int` detection / `TaggedUnion` /
 * input twin functor land together so the catalog resolvers
 * (`apps/default/src/server/graphql/resolvers/`) can derive every
 * GraphQL type from its Schema source rather than maintaining a
 * parallel hand-rolled hierarchy. ADR-0041 records the migration.
 */

/* -------------------------------------------------------------------------- */
/* Options                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Output-side field nullability policy.
 *
 * - `"schema-faithful"` (default) — required fields land as
 *   `GraphQLNonNull`, fields marked `Schema.optional` stay nullable.
 *   This is the principled reading: the Schema knows which fields
 *   may be absent, and GraphQL surfaces that to clients.
 * - `"nullable"` — every field is nullable, regardless of Schema. The
 *   Pothos baseline used this; left in place for callers that want
 *   to reproduce a pre-existing SDL.
 * - `"nonNull"` — every field is non-null, regardless of Schema. Useful
 *   for schemas where every property is intentionally required.
 */
type FieldNullability = "schema-faithful" | "nullable" | "nonNull"

export type DeriveOptions = {
  /** Required when the schema is a Struct without an inherent name. */
  readonly name?: string
  /** Optional GraphQL description attached to the top-level type. */
  readonly description?: string
  /** Optional dedupe registry shared across nested calls. */
  readonly registry?: TypeRegistry
  /** Defaults to `"schema-faithful"`. */
  readonly fieldNullability?: FieldNullability
  /**
   * Brand → custom scalar mapping. Any AST whose resolved brands
   * include a key in this map returns the registered scalar.
   */
  readonly scalarRegistry?: ReadonlyMap<string, GraphQLScalarType>
}

export type DeriveInputOptions = Omit<DeriveOptions, "fieldNullability" | "registry"> & {
  readonly registry?: InputTypeRegistry
}

/**
 * Shared dedupe registry for the output functor — covers both
 * `GraphQLObjectType` (Objects) and `GraphQLUnionType` (TaggedUnion).
 */
export type TypeRegistry = Map<string, GraphQLObjectType | GraphQLUnionType>

export type InputTypeRegistry = Map<string, GraphQLInputObjectType>

export const makeTypeRegistry = (): TypeRegistry => new Map()
export const makeInputTypeRegistry = (): InputTypeRegistry => new Map()

/* -------------------------------------------------------------------------- */
/* AST inspection helpers                                                      */
/* -------------------------------------------------------------------------- */

type AnnotationsLike = { readonly brands?: readonly string[] } & Record<string, unknown>

const resolveAnnotations = (ast: SchemaAST.AST): AnnotationsLike | undefined => {
  // Effect's `resolveAt` rule: if `ast.checks` is non-empty, look at
  // the last check's annotations; otherwise the AST's own
  // annotations. Mirrors `effect/src/internal/schema/annotations.ts`.
  const checks = ast.checks
  if (checks !== undefined && checks.length > 0) {
    const last = checks[checks.length - 1]
    return last?.annotations
  }
  return ast.annotations
}

const resolveBrands = (ast: SchemaAST.AST): readonly string[] | undefined =>
  resolveAnnotations(ast)?.brands

const resolveIdentifierName = (ast: SchemaAST.AST): string | undefined => {
  const id = resolveAnnotations(ast)?.identifier
  return typeof id === "string" ? id : undefined
}

const findBrandedScalar = (
  ast: SchemaAST.AST,
  scalarRegistry: ReadonlyMap<string, GraphQLScalarType> | undefined,
): GraphQLScalarType | undefined => {
  if (scalarRegistry === undefined) return undefined
  const brands = resolveBrands(ast)
  if (brands === undefined) return undefined
  for (const b of brands) {
    const s = scalarRegistry.get(b)
    if (s !== undefined) return s
  }
  return undefined
}

const hasIsIntCheck = (ast: SchemaAST.AST): boolean => {
  const checks = ast.checks
  if (checks === undefined || checks.length === 0) return false
  for (const c of checks) {
    const meta = (c.annotations?.meta as { readonly _tag?: unknown } | undefined) ?? undefined
    if (meta?._tag === "isInt") return true
  }
  return false
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

const isUnion = (
  ast: SchemaAST.AST,
): ast is SchemaAST.AST & { readonly types: readonly SchemaAST.AST[] } => ast._tag === "Union"

const isOptional = (ast: SchemaAST.AST): boolean => {
  const ctx = (ast as unknown as { readonly context?: { readonly isOptional?: boolean } }).context
  return ctx?.isOptional ?? false
}

/**
 * Extract the `_tag` literal values from a `TaggedUnion` whose
 * members are all `Objects` carrying a single `_tag: Literal<…>`
 * field. Returns the per-member tag in declaration order, or
 * `undefined` if the union is not a tagged union of structs.
 */
const taggedUnionMembers = (
  ast: SchemaAST.AST,
): readonly { readonly tag: string; readonly type: SchemaAST.AST }[] | undefined => {
  if (!isUnion(ast)) return undefined
  const out: { readonly tag: string; readonly type: SchemaAST.AST }[] = []
  for (const member of ast.types) {
    if (!isObjects(member)) return undefined
    let tag: string | undefined
    for (const prop of member.propertySignatures) {
      if (prop.name !== "_tag") continue
      if (prop.type._tag !== "Literal") return undefined
      const lit = (prop.type as unknown as { readonly literal: unknown }).literal
      if (typeof lit !== "string") return undefined
      tag = lit
      break
    }
    if (tag === undefined) return undefined
    out.push({ tag, type: member })
  }
  return out
}

/* -------------------------------------------------------------------------- */
/* Output functor                                                              */
/* -------------------------------------------------------------------------- */

const wrapField = (
  inner: GraphQLOutputType,
  policy: FieldNullability,
  propType: SchemaAST.AST,
): GraphQLOutputType => {
  switch (policy) {
    case "nonNull":
      return new GraphQLNonNull(inner)
    case "nullable":
      return inner
    case "schema-faithful":
      return isOptional(propType) ? inner : new GraphQLNonNull(inner)
  }
}

const astToOutputType = (
  ast: SchemaAST.AST,
  registry: TypeRegistry,
  policy: FieldNullability,
  scalarRegistry: ReadonlyMap<string, GraphQLScalarType> | undefined,
  hintArg?: string,
  description?: string,
): GraphQLOutputType => {
  const branded = findBrandedScalar(ast, scalarRegistry)
  if (branded !== undefined) return branded

  // Caller-supplied `name` wins; otherwise read the schema's own
  // `identifier` annotation. Lets nested struct ASTs name themselves
  // without the recursion having to thread a path argument.
  const hint = hintArg ?? resolveIdentifierName(ast)

  switch (ast._tag) {
    case "String":
    case "Literal":
      return GraphQLString
    case "Number":
      return hasIsIntCheck(ast) ? GraphQLInt : GraphQLFloat
    case "Boolean":
      return GraphQLBoolean
    default:
      break
  }

  const literals = stringLiteralValues(ast)
  if (literals !== undefined && hint !== undefined) {
    return enumFromLiterals(hint, literals)
  }

  const tagged = taggedUnionMembers(ast)
  if (tagged !== undefined && hint !== undefined) {
    const cached = registry.get(hint)
    if (cached !== undefined) return cached
    const memberTypeByTag = new Map<string, GraphQLObjectType>()
    const placeholder = new GraphQLUnionType({
      name: hint,
      types: () => {
        const out: GraphQLObjectType[] = []
        for (const m of tagged) {
          const t = memberTypeByTag.get(m.tag)
          if (t !== undefined) out.push(t)
        }
        return out
      },
      resolveType: (value) => {
        const t = (value as { readonly _tag?: unknown })._tag
        if (typeof t !== "string") return undefined
        return memberTypeByTag.get(t)?.name
      },
    })
    registry.set(hint, placeholder)
    for (const m of tagged) {
      const memberHint = `${hint}_${m.tag}`
      const memberType = astToOutputType(m.type, registry, policy, scalarRegistry, memberHint)
      memberTypeByTag.set(m.tag, memberType as GraphQLObjectType)
    }
    return placeholder
  }

  if (isArrays(ast)) {
    const rest = ast.rest[0]
    if (rest !== undefined) {
      return new GraphQLList(
        new GraphQLNonNull(astToOutputType(rest, registry, policy, scalarRegistry)),
      )
    }
  }

  if (isObjects(ast)) {
    if (hint !== undefined) {
      const cached = registry.get(hint)
      if (cached !== undefined) return cached as GraphQLObjectType
    }
    const placeholder = new GraphQLObjectType({
      name: hint ?? "AnonymousStruct",
      description,
      fields: () => {
        const out: Record<string, { type: GraphQLOutputType }> = {}
        for (const prop of ast.propertySignatures) {
          if (typeof prop.name !== "string") continue
          const inner = astToOutputType(prop.type, registry, policy, scalarRegistry)
          out[prop.name] = { type: wrapField(inner, policy, prop.type) }
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
 * Top-level entry point for the output functor. Lift an Effect
 * `Schema.Codec` to a `GraphQLOutputType`. Caller supplies `name`
 * for any schema that doesn't carry an inherent identifier, an
 * optional shared `registry` to dedupe across calls, and the
 * `scalarRegistry` mapping branded names to pre-built scalars.
 */
export const schemaToGraphQLOutputType = (
  schema: Schema.Top,
  options: DeriveOptions = {},
): GraphQLOutputType => {
  const registry = options.registry ?? makeTypeRegistry()
  const policy = options.fieldNullability ?? "schema-faithful"
  return astToOutputType(
    schema.ast,
    registry,
    policy,
    options.scalarRegistry,
    options.name,
    options.description,
  )
}

/* -------------------------------------------------------------------------- */
/* Input functor                                                               */
/* -------------------------------------------------------------------------- */

const astToInputType = (
  ast: SchemaAST.AST,
  registry: InputTypeRegistry,
  scalarRegistry: ReadonlyMap<string, GraphQLScalarType> | undefined,
  hintArg?: string,
  description?: string,
): GraphQLInputType => {
  const branded = findBrandedScalar(ast, scalarRegistry)
  if (branded !== undefined) return branded

  const hint = hintArg ?? resolveIdentifierName(ast)

  switch (ast._tag) {
    case "String":
    case "Literal":
      return GraphQLString
    case "Number":
      return hasIsIntCheck(ast) ? GraphQLInt : GraphQLFloat
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
      return new GraphQLList(new GraphQLNonNull(astToInputType(rest, registry, scalarRegistry)))
    }
  }

  if (isObjects(ast)) {
    if (hint !== undefined) {
      const cached = registry.get(hint)
      if (cached !== undefined) return cached
    }
    const placeholder = new GraphQLInputObjectType({
      name: hint ?? "AnonymousInputStruct",
      description,
      fields: () => {
        const out: Record<string, { type: GraphQLInputType }> = {}
        for (const prop of ast.propertySignatures) {
          if (typeof prop.name !== "string") continue
          const inner = astToInputType(prop.type, registry, scalarRegistry)
          // Inputs are always schema-faithful: optional → nullable,
          // required → NonNull. GraphQL has no "everything nullable"
          // input idiom (clients would have to pass undefined in
          // every variable), so we don't expose a policy parameter.
          out[prop.name] = {
            type: isOptional(prop.type) ? inner : new GraphQLNonNull(inner),
          }
        }
        return out
      },
    })
    if (hint !== undefined) registry.set(hint, placeholder)
    return placeholder
  }

  // GraphQL forbids unions of struct types in input positions; the
  // caller pre-validates discriminated payloads at the resolver
  // boundary. If a TaggedUnion ever needs to enter an input we'd
  // splice it as an interface + multiple input shapes, which is out
  // of scope for the booking surface today.
  return GraphQLString
}

/**
 * Top-level entry point for the input functor. Mirrors
 * {@link schemaToGraphQLOutputType} on the input side.
 */
export const schemaToGraphQLInputType = (
  schema: Schema.Top,
  options: DeriveInputOptions = {},
): GraphQLInputType => {
  const registry = options.registry ?? makeInputTypeRegistry()
  return astToInputType(
    schema.ast,
    registry,
    options.scalarRegistry,
    options.name,
    options.description,
  )
}
