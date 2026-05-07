import { ServiceFromRow } from "@booking/core"
import { Schema } from "effect"
import {
  GraphQLBoolean,
  GraphQLFloat,
  type GraphQLNonNull,
  type GraphQLObjectType,
  type GraphQLOutputType,
  GraphQLString,
  isListType,
  isNonNullType,
  isObjectType,
} from "graphql"
import { describe, expect, it } from "vitest"
import { schemaToGraphQLOutputType } from "../../src/server/graphql/derive.js"

describe("schemaToGraphQLOutputType — Schema → GraphQLType functor", () => {
  it("lifts Schema.String to GraphQLString", () => {
    expect(schemaToGraphQLOutputType(Schema.String)).toBe(GraphQLString)
  })

  it("lifts Schema.Number to GraphQLFloat", () => {
    expect(schemaToGraphQLOutputType(Schema.Number)).toBe(GraphQLFloat)
  })

  it("lifts Schema.Boolean to GraphQLBoolean", () => {
    expect(schemaToGraphQLOutputType(Schema.Boolean)).toBe(GraphQLBoolean)
  })

  it("lifts Schema.Array(String) to GraphQLList(NonNull(String))", () => {
    const out: GraphQLOutputType = schemaToGraphQLOutputType(Schema.Array(Schema.String))
    expect(isListType(out)).toBe(true)
    if (!isListType(out)) return
    const inner = out.ofType as GraphQLOutputType
    expect(isNonNullType(inner)).toBe(true)
    if (!isNonNullType(inner)) return
    expect((inner as GraphQLNonNull<typeof GraphQLString>).ofType).toBe(GraphQLString)
  })

  it("lifts Schema.Struct to a named GraphQLObjectType with nullable fields by default", () => {
    // The default policy is `"nullable"` so the printed SDL byte-
    // matches the gold (Pothos defaults output fields to nullable).
    const Pair = Schema.Struct({ a: Schema.String, b: Schema.Number })
    const out = schemaToGraphQLOutputType(Pair, { name: "Pair" })
    expect(isObjectType(out)).toBe(true)
    const obj = out as GraphQLObjectType
    expect(obj.name).toBe("Pair")
    const fields = obj.getFields()
    expect(fields.a?.type.toString()).toBe("String")
    expect(fields.b?.type.toString()).toBe("Float")
  })

  it("opts in to NonNull-wrapped fields when fieldNullability is 'nonNull'", () => {
    // Strict-Schema reading: required fields surface as non-null
    // GraphQL types. Reserved for callers operating on a schema
    // category where every property is intentionally non-optional.
    const Pair = Schema.Struct({ a: Schema.String, b: Schema.Number })
    const out = schemaToGraphQLOutputType(Pair, {
      name: "PairStrict",
      fieldNullability: "nonNull",
    })
    expect(isObjectType(out)).toBe(true)
    const fields = (out as GraphQLObjectType).getFields()
    expect(fields.a?.type.toString()).toBe("String!")
    expect(fields.b?.type.toString()).toBe("Float!")
  })

  it("dedupes a struct by name across calls via shared registry", () => {
    const Pair = Schema.Struct({ a: Schema.String })
    const registry = new Map<string, GraphQLObjectType>()
    const t1 = schemaToGraphQLOutputType(Pair, { name: "Pair", registry })
    const t2 = schemaToGraphQLOutputType(Pair, { name: "Pair", registry })
    expect(t1).toBe(t2)
  })

  it("derives a real catalog row schema (ServiceFromRow encoded)", () => {
    // ServiceFromRow has many string / number / boolean fields plus
    // an array — exercises the structural recursion end-to-end.
    const out = schemaToGraphQLOutputType(ServiceFromRow, { name: "ServiceFromRow" })
    expect(isObjectType(out)).toBe(true)
    const obj = out as GraphQLObjectType
    expect(obj.name).toBe("ServiceFromRow")
  })
})
