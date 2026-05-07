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
})
