import { execute, GraphQLObjectType, GraphQLSchema, GraphQLString, parse } from "graphql"
import { describe, expect, it } from "vitest"
import { BookingError } from "../../src/server/graphql/errors.js"
import {
  bookingErrorType,
  bookingSourceEnumType,
  errorEnvelope,
  instantScalar,
  makeEnvelopeRegistry,
  phoneLast4Scalar,
  plainDateScalar,
} from "../../src/server/graphql/resolver.js"

/**
 * PR#7 M17 — direct verification of the `errorEnvelope` combinator.
 *
 * The combinator is the Result<BookingError, A> projection onto the
 * GraphQL category. Two arms must round-trip:
 *
 *   1. Success path — body returns a value, `Mutation<Verb>Success`
 *      arm carries `{ data }`.
 *   2. Failure path — body throws a `BookingError`, `BookingError`
 *      arm carries the structured payload.
 *
 * `graphql.execute` drives the schema directly without yoga so the
 * test is hermetic; only the combinator's behaviour is asserted.
 */

const buildTinySchema = () => {
  const registry = makeEnvelopeRegistry()
  const mutation = new GraphQLObjectType({
    name: "Mutation",
    fields: () => ({
      okTest: errorEnvelope({
        verb: "OkTest",
        inner: GraphQLString,
        args: {},
        registry,
        body: () => Promise.resolve("ok"),
      }),
      failTest: errorEnvelope({
        verb: "FailTest",
        inner: GraphQLString,
        args: {},
        registry,
        body: () =>
          Promise.reject(
            new BookingError({
              __typename: "Storage",
              code: "E_INF_STORAGE",
              severity: "infrastructure",
              i18nKey: "error.Storage" as never,
            }),
          ),
      }),
    }),
  })
  return new GraphQLSchema({
    query: new GraphQLObjectType({
      name: "Query",
      fields: () => ({ ping: { type: GraphQLString, resolve: () => "pong" } }),
    }),
    mutation,
  })
}

describe("errorEnvelope — Result<BookingError, A> projection", () => {
  it("routes success-path body to Mutation<Verb>Success.data", async () => {
    const schema = buildTinySchema()
    const result = await execute({
      schema,
      document: parse(`mutation { okTest { __typename ... on MutationOkTestSuccess { data } } }`),
    })
    expect(result.errors).toBeUndefined()
    expect(result.data).toEqual({
      okTest: { __typename: "MutationOkTestSuccess", data: "ok" },
    })
  })

  it("routes thrown BookingError to BookingError union arm with payload", async () => {
    const schema = buildTinySchema()
    const result = await execute({
      schema,
      document: parse(
        `mutation { failTest { __typename ... on BookingError { tag code severity i18nKey } } }`,
      ),
    })
    expect(result.errors).toBeUndefined()
    expect(result.data).toEqual({
      failTest: {
        __typename: "BookingError",
        tag: "Storage",
        code: "E_INF_STORAGE",
        severity: "infrastructure",
        i18nKey: "error.Storage",
      },
    })
  })

  it("dedupes Mutation<Verb>Success / Mutation<Verb>Result by verb across calls", () => {
    const registry = makeEnvelopeRegistry()
    const a = errorEnvelope({
      verb: "Same",
      inner: GraphQLString,
      args: {},
      registry,
      body: () => Promise.resolve("1"),
    })
    const b = errorEnvelope({
      verb: "Same",
      inner: GraphQLString,
      args: {},
      registry,
      body: () => Promise.resolve("2"),
    })
    expect(a.type).toBe(b.type)
  })
})

describe("resolver primitives — gold-SDL anchors", () => {
  it("PlainDate / Instant / PhoneLast4 scalars carry their gold names + descriptions", () => {
    expect(plainDateScalar.name).toBe("PlainDate")
    expect(plainDateScalar.description).toBe("ISO-8601 calendar date (e.g. 2026-05-05).")
    expect(instantScalar.name).toBe("Instant")
    expect(instantScalar.description).toBe("ISO-8601 instant in UTC (e.g. 2026-05-05T09:30:00Z).")
    expect(phoneLast4Scalar.name).toBe("PhoneLast4")
    expect(phoneLast4Scalar.description).toBe(
      "Last four digits of a phone number — exactly four ASCII digits.",
    )
  })

  it("BookingSource enum exposes the four domain literals", () => {
    expect(bookingSourceEnumType.name).toBe("BookingSource")
    const names = bookingSourceEnumType
      .getValues()
      .map((v) => v.name)
      .sort()
    expect(names).toEqual(["online", "phone", "staff", "walkin"])
  })

  it("BookingError type carries the five wire fields", () => {
    expect(bookingErrorType.name).toBe("BookingError")
    const fieldNames = Object.keys(bookingErrorType.getFields()).sort()
    expect(fieldNames).toEqual(["code", "i18nKey", "message", "severity", "tag"])
  })
})
