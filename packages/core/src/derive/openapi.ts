import type { Schema, SchemaAST } from "effect"

/**
 * Pure functor `Schema → OpenAPISchema 3.1`.
 *
 * Twin of `apps/default/src/server/graphql/derive.ts` (PR#7 M16) —
 * both consume the same Effect Schema source category. This module
 * gives the deployment a Schema-driven path to emit JSON Schema /
 * OpenAPI 3.1 artefacts (component schemas + `/healthz` response
 * shapes etc.) from the same Schema declarations the rest of the
 * domain reads.
 *
 * Coverage matches the variants the rest of `derive/` already
 * emits: scalar leaves (`String` / `Number` / `Boolean` /
 * `Literal`), `Arrays`, `Objects` with required-field detection,
 * and `Union` of string `Literal`s lifted to JSON Schema's `enum`.
 *
 * Out of scope for the M21 land:
 *
 * - `Union` of structs (would emit `oneOf` + discriminator) — wire
 *   the booking event union when the consumer arrives.
 * - Custom keywords (`format: "date-time"`, `pattern`, `minLength`)
 *   — the existing `derive/algebra.ts` predicate fold owns those
 *   projections; a follow-up pass can stitch them in.
 *
 * Profunctor-with-graphql twin: this module + `derive/graphql.ts`
 * sit over the same source category and produce two parallel
 * artefacts. ADR-0041 (GraphQL migration) and the build-time
 * artifact emitter (PR#8 M23) are the consumers that bring the
 * twin functor pattern to runtime.
 */

export type OpenAPISchemaObject = {
  readonly type?: string
  readonly format?: string
  readonly items?: OpenAPISchemaObject
  readonly properties?: Readonly<Record<string, OpenAPISchemaObject>>
  readonly required?: readonly string[]
  readonly enum?: readonly string[]
  readonly $ref?: string
  readonly description?: string
}

export type DeriveOpenAPIOptions = {
  /** Component schema name when the schema is an Objects or named enum. */
  readonly name?: string
  /** Optional registry; encountered named schemas register here for $ref deduplication. */
  readonly registry?: Map<string, OpenAPISchemaObject>
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

const isObjects = (
  ast: SchemaAST.AST,
): ast is SchemaAST.AST & {
  readonly propertySignatures: readonly SchemaAST.PropertySignature[]
} => ast._tag === "Objects"

const isArrays = (
  ast: SchemaAST.AST,
): ast is SchemaAST.AST & { readonly rest: readonly SchemaAST.AST[] } => ast._tag === "Arrays"

const astToOpenAPI = (
  ast: SchemaAST.AST,
  registry: Map<string, OpenAPISchemaObject>,
  hint?: string,
): OpenAPISchemaObject => {
  switch (ast._tag) {
    case "String":
      return { type: "string" }
    case "Number":
      return { type: "number" }
    case "Boolean":
      return { type: "boolean" }
    case "Literal": {
      const lit = (ast as unknown as { readonly literal: unknown }).literal
      if (typeof lit === "string") return { type: "string", enum: [lit] }
      if (typeof lit === "number") return { type: "number" }
      if (typeof lit === "boolean") return { type: "boolean" }
      return {}
    }
    default:
      break
  }

  const literals = stringLiteralValues(ast)
  if (literals !== undefined) {
    return { type: "string", enum: literals }
  }

  if (isArrays(ast)) {
    const rest = ast.rest[0]
    if (rest !== undefined) {
      return { type: "array", items: astToOpenAPI(rest, registry) }
    }
    return { type: "array" }
  }

  if (isObjects(ast)) {
    const properties: Record<string, OpenAPISchemaObject> = {}
    const required: string[] = []
    for (const prop of ast.propertySignatures) {
      if (typeof prop.name !== "string") continue
      properties[prop.name] = astToOpenAPI(prop.type, registry)
      required.push(prop.name)
    }
    const out: OpenAPISchemaObject = {
      type: "object",
      properties,
      required,
    }
    if (hint !== undefined) registry.set(hint, out)
    return out
  }

  return {}
}

/**
 * Top-level entry point. Lift an Effect `Schema.Codec` to an
 * OpenAPI 3.1 schema object. Caller supplies `name` for any schema
 * that should register in a `components.schemas` block, and
 * optionally a `registry` to share the registration across nested
 * calls.
 */
export const schemaToOpenAPISchema = (
  schema: Schema.Top,
  options: DeriveOpenAPIOptions = {},
): OpenAPISchemaObject => {
  const registry = options.registry ?? new Map<string, OpenAPISchemaObject>()
  return astToOpenAPI(schema.ast, registry, options.name)
}
