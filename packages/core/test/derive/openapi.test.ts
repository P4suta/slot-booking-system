import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { type OpenAPISchemaObject, schemaToOpenAPISchema } from "../../src/derive/openapi.js"

describe("schemaToOpenAPISchema — Schema → OpenAPI 3.1 functor", () => {
  it("lifts Schema.String to {type: 'string'}", () => {
    expect(schemaToOpenAPISchema(Schema.String)).toEqual({ type: "string" })
  })

  it("lifts Schema.Number to {type: 'number'}", () => {
    expect(schemaToOpenAPISchema(Schema.Number)).toEqual({ type: "number" })
  })

  it("lifts Schema.Boolean to {type: 'boolean'}", () => {
    expect(schemaToOpenAPISchema(Schema.Boolean)).toEqual({ type: "boolean" })
  })

  it("lifts Schema.Literal('online') to {type: 'string', enum: ['online']}", () => {
    expect(schemaToOpenAPISchema(Schema.Literal("online"))).toEqual({
      type: "string",
      enum: ["online"],
    })
  })

  it("lifts Schema.Literals to {type: 'string', enum: [...]}", () => {
    expect(schemaToOpenAPISchema(Schema.Literals(["online", "walkin"]))).toEqual({
      type: "string",
      enum: ["online", "walkin"],
    })
  })

  it("lifts Schema.Array(String) to array with items", () => {
    expect(schemaToOpenAPISchema(Schema.Array(Schema.String))).toEqual({
      type: "array",
      items: { type: "string" },
    })
  })

  it("lifts Schema.Struct to {type: 'object', properties, required}", () => {
    const Pair = Schema.Struct({ a: Schema.String, b: Schema.Number })
    const out = schemaToOpenAPISchema(Pair, { name: "Pair" })
    expect(out.type).toBe("object")
    expect(out.properties).toEqual({
      a: { type: "string" },
      b: { type: "number" },
    })
    expect(out.required).toEqual(["a", "b"])
  })

  it("registers named schemas in the shared registry", () => {
    const Pair = Schema.Struct({ a: Schema.String })
    const registry = new Map<string, OpenAPISchemaObject>()
    schemaToOpenAPISchema(Pair, { name: "Pair", registry })
    expect(registry.has("Pair")).toBe(true)
  })

  it("lifts Schema.Literal(42) (numeric) to {type: 'number'}", () => {
    expect(schemaToOpenAPISchema(Schema.Literal(42))).toEqual({ type: "number" })
  })

  it("lifts Schema.Literal(true) (boolean) to {type: 'boolean'}", () => {
    expect(schemaToOpenAPISchema(Schema.Literal(true))).toEqual({ type: "boolean" })
  })

  it("falls back to {} for an unsupported AST shape", () => {
    // Effect's `Schema.Unknown` produces an AST that the functor does
    // not recognise — neither a leaf scalar nor an Objects/Arrays
    // composite. The fallback `return {}` should fire.
    expect(schemaToOpenAPISchema(Schema.Unknown)).toEqual({})
  })

  it("falls back to {} for a Literal whose value is a bigint", () => {
    // Effect's LiteralValue admits bigint; OpenAPI 3.1 has no native
    // bigint shape, so the projection returns the empty schema. The
    // fallback line `return {}` inside the Literal switch arm is the
    // structural witness.
    expect(schemaToOpenAPISchema(Schema.Literal(42n))).toEqual({})
  })

  it("emits a bare {type: 'array'} for a Tuple with no element type", () => {
    // `Schema.Tuple([])` produces an Arrays AST with `rest = []`, so
    // the projection has no inner schema to nest into `items` and
    // emits the unitary `{ type: "array" }` shape.
    expect(schemaToOpenAPISchema(Schema.Tuple([]))).toEqual({ type: "array" })
  })

  it("falls back to {} for a Union containing non-Literal members", () => {
    // `Schema.Union([Number, Boolean])` is a Union AST where
    // `stringLiteralValues` rejects on the first non-Literal member,
    // and the outer `astToOpenAPI` has no other arm for it.
    expect(schemaToOpenAPISchema(Schema.Union([Schema.Number, Schema.Boolean]))).toEqual({})
  })

  it("falls back to {} for a Union of Literals whose values are not all strings", () => {
    // The Literal members are valid, but `stringLiteralValues` requires
    // every member's literal to be a string before lifting to `enum`.
    expect(schemaToOpenAPISchema(Schema.Union([Schema.Literal("a"), Schema.Literal(42)]))).toEqual(
      {},
    )
  })

  it("falls back to {} for an empty Union (the literal-collector returns undefined)", () => {
    expect(schemaToOpenAPISchema(Schema.Union([]))).toEqual({})
  })

  it("emits an Object schema without registering when no `name` is supplied", () => {
    const Pair = Schema.Struct({ a: Schema.String, b: Schema.Number })
    const registry = new Map<string, OpenAPISchemaObject>()
    const out = schemaToOpenAPISchema(Pair, { registry })
    expect(out.type).toBe("object")
    expect(out.required).toEqual(["a", "b"])
    expect(registry.size).toBe(0)
  })
})
