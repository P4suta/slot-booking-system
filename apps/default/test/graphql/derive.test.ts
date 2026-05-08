import { ServiceFromRow } from "@booking/core"
import { Schema } from "effect"
import {
  GraphQLBoolean,
  GraphQLFloat,
  type GraphQLInputObjectType,
  GraphQLInt,
  type GraphQLObjectType,
  type GraphQLOutputType,
  GraphQLScalarType,
  GraphQLString,
  GraphQLUnionType,
  isInputObjectType,
  isListType,
  isNonNullType,
  isObjectType,
} from "graphql"
import { describe, expect, it } from "vitest"
import {
  makeInputTypeRegistry,
  makeTypeRegistry,
  schemaToGraphQLInputType,
  schemaToGraphQLOutputType,
} from "../../src/server/graphql/derive.js"

describe("schemaToGraphQLOutputType — Schema → GraphQLOutputType functor", () => {
  it("lifts Schema.String to GraphQLString", () => {
    expect(schemaToGraphQLOutputType(Schema.String)).toBe(GraphQLString)
  })

  it("lifts Schema.Number to GraphQLFloat", () => {
    expect(schemaToGraphQLOutputType(Schema.Number)).toBe(GraphQLFloat)
  })

  it("lifts Schema.Number with isInt() filter to GraphQLInt", () => {
    // The Number → Int detection walks `ast.checks` for the `isInt`
    // filter annotation (`meta._tag === "isInt"`) and lifts to
    // GraphQLInt when present, falling back to GraphQLFloat.
    const intSchema = Schema.Number.check(Schema.isInt())
    expect(schemaToGraphQLOutputType(intSchema)).toBe(GraphQLInt)
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
  })

  it("lifts Schema.Struct to schema-faithful GraphQLObjectType by default", () => {
    // Default `"schema-faithful"` policy: required fields surface as
    // NonNull, fields marked Schema.optional stay nullable.
    const Pair = Schema.Struct({
      a: Schema.String,
      b: Schema.Number,
      c: Schema.optional(Schema.String),
    })
    const out = schemaToGraphQLOutputType(Pair, { name: "Pair" })
    expect(isObjectType(out)).toBe(true)
    const obj = out as GraphQLObjectType
    expect(obj.name).toBe("Pair")
    const fields = obj.getFields()
    expect(fields.a?.type.toString()).toBe("String!")
    expect(fields.b?.type.toString()).toBe("Float!")
    expect(fields.c?.type.toString()).toBe("String")
  })

  it("opts in to all-nullable fields when fieldNullability is 'nullable'", () => {
    const Pair = Schema.Struct({ a: Schema.String, b: Schema.Number })
    const out = schemaToGraphQLOutputType(Pair, {
      name: "PairNullable",
      fieldNullability: "nullable",
    })
    expect(isObjectType(out)).toBe(true)
    const fields = (out as GraphQLObjectType).getFields()
    expect(fields.a?.type.toString()).toBe("String")
    expect(fields.b?.type.toString()).toBe("Float")
  })

  it("opts in to all-NonNull fields when fieldNullability is 'nonNull'", () => {
    const Pair = Schema.Struct({
      a: Schema.String,
      b: Schema.optional(Schema.String),
    })
    const out = schemaToGraphQLOutputType(Pair, {
      name: "PairStrict",
      fieldNullability: "nonNull",
    })
    expect(isObjectType(out)).toBe(true)
    const fields = (out as GraphQLObjectType).getFields()
    // `"nonNull"` ignores `Schema.optional` and wraps every field.
    expect(fields.a?.type.toString()).toBe("String!")
    expect(fields.b?.type.toString()).toBe("String!")
  })

  it("maps Schema.brand to a registered GraphQLScalarType", () => {
    // Brand-aware mapping: `Schema.brand("PlainDate")` resolves
    // through `scalarRegistry` to the pre-built scalar.
    const plainDate = new GraphQLScalarType({ name: "PlainDate", serialize: (v) => v })
    const Branded = Schema.String.pipe(Schema.brand("PlainDate"))
    const out = schemaToGraphQLOutputType(Branded, {
      scalarRegistry: new Map([["PlainDate", plainDate]]),
    })
    expect(out).toBe(plainDate)
  })

  it("dedupes a struct by name across calls via shared registry", () => {
    const Pair = Schema.Struct({ a: Schema.String })
    const registry = makeTypeRegistry()
    const t1 = schemaToGraphQLOutputType(Pair, { name: "Pair", registry })
    const t2 = schemaToGraphQLOutputType(Pair, { name: "Pair", registry })
    expect(t1).toBe(t2)
  })

  it("lifts a tagged union of structs to a GraphQLUnionType with _tag resolution", () => {
    const Square = Schema.Struct({ _tag: Schema.Literal("Square"), side: Schema.Number })
    const Circle = Schema.Struct({ _tag: Schema.Literal("Circle"), radius: Schema.Number })
    const Shape = Schema.Union([Square, Circle])
    const out = schemaToGraphQLOutputType(Shape, { name: "Shape" })
    expect(out).toBeInstanceOf(GraphQLUnionType)
    const u = out as GraphQLUnionType
    expect(u.name).toBe("Shape")
    const memberNames = u.getTypes().map((t) => t.name)
    expect(memberNames).toEqual(["Shape_Square", "Shape_Circle"])
    const resolveType = u.resolveType
    expect(typeof resolveType).toBe("function")
    if (typeof resolveType !== "function") return
    expect(resolveType({ _tag: "Square", side: 3 }, {}, {} as never, u)).toBe("Shape_Square")
    expect(resolveType({ _tag: "Circle", radius: 5 }, {}, {} as never, u)).toBe("Shape_Circle")
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

describe("schemaToGraphQLInputType — Schema → GraphQLInputType dual functor", () => {
  it("lifts scalar leaves identically to the output functor", () => {
    expect(schemaToGraphQLInputType(Schema.String)).toBe(GraphQLString)
    expect(schemaToGraphQLInputType(Schema.Number)).toBe(GraphQLFloat)
    expect(schemaToGraphQLInputType(Schema.Boolean)).toBe(GraphQLBoolean)
    expect(schemaToGraphQLInputType(Schema.Number.check(Schema.isInt()))).toBe(GraphQLInt)
  })

  it("lifts Schema.Struct to a GraphQLInputObjectType with required + optional fields", () => {
    const Input = Schema.Struct({
      id: Schema.optional(Schema.String),
      name: Schema.String,
      enabled: Schema.Boolean,
    })
    const out = schemaToGraphQLInputType(Input, { name: "ExampleInput" })
    expect(isInputObjectType(out)).toBe(true)
    const obj = out as GraphQLInputObjectType
    expect(obj.name).toBe("ExampleInput")
    const fields = obj.getFields()
    expect(fields.id?.type.toString()).toBe("String")
    expect(fields.name?.type.toString()).toBe("String!")
    expect(fields.enabled?.type.toString()).toBe("Boolean!")
  })

  it("dedupes input structs by name across calls via shared registry", () => {
    const Input = Schema.Struct({ values: Schema.Array(Schema.String) })
    const registry = makeInputTypeRegistry()
    const a = schemaToGraphQLInputType(Input, { name: "ListInput", registry })
    const b = schemaToGraphQLInputType(Input, { name: "ListInput", registry })
    expect(a).toBe(b)
  })

  it("maps brand annotations on input types through scalarRegistry too", () => {
    const phoneScalar = new GraphQLScalarType({ name: "PhoneLast4", serialize: (v) => v })
    const Branded = Schema.String.pipe(Schema.brand("PhoneLast4"))
    const out = schemaToGraphQLInputType(Branded, {
      scalarRegistry: new Map([["PhoneLast4", phoneScalar]]),
    })
    expect(out).toBe(phoneScalar)
  })
})
