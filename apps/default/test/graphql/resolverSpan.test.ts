import { trace } from "@opentelemetry/api"
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import { execute, GraphQLObjectType, GraphQLSchema, GraphQLString, parse } from "graphql"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { BookingError } from "../../src/server/graphql/errors.js"
import { errorEnvelope, makeEnvelopeRegistry } from "../../src/server/graphql/resolver.js"

/**
 * Pin the wire-side contract added by commit 4: every mutation
 * resolver opens a `graphql.<Verb>` active span around the body so
 * the use-case-level `usecase.<Verb>` span (added in the same commit
 * for HoldSlot / ConfirmBooking / CancelBooking / RescheduleBooking
 * / ExpireBooking / PurgeStalePii) lands as a child. Combined with
 * the worker-root `instrument(...)` span, the trace tree is three
 * layers deep — exactly what an operator looking at Jaeger needs to
 * pinpoint where time was spent or where the throw came from.
 *
 * The `BookingError` arm intentionally leaves span status unset so
 * Jaeger's error counters track only unexpected failures. The
 * `useDomainErrorTrace` plugin attaches `error.*` attributes for
 * monitoring without flipping the status code.
 */
describe("graphql.<Verb> span emission (errorEnvelope)", () => {
  let provider: BasicTracerProvider
  let exporter: InMemorySpanExporter

  beforeEach(() => {
    exporter = new InMemorySpanExporter()
    provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    })
    trace.setGlobalTracerProvider(provider)
  })

  afterEach(async () => {
    await provider.shutdown()
    exporter.reset()
    // OTel's `setGlobalTracerProvider` is one-shot — without `disable()`
    // a subsequent `setGlobalTracerProvider` in the next beforeEach is
    // a silent no-op and the test would observe spans from the
    // shut-down provider (= empty).
    trace.disable()
  })

  const buildSchema = (registry = makeEnvelopeRegistry()) => {
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
        boomTest: errorEnvelope({
          verb: "BoomTest",
          inner: GraphQLString,
          args: {},
          registry,
          body: () =>
            Promise.reject(
              new BookingError({
                __typename: "TransportError",
                code: "E_INF_TRANSPORT",
                severity: "infrastructure",
                i18nKey: "error.TransportError" as never,
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

  it("emits a graphql.OkTest span on the success path", async () => {
    const schema = buildSchema()
    await execute({
      schema,
      document: parse("mutation { okTest { __typename ... on MutationOkTestSuccess { data } } }"),
    })
    await provider.forceFlush()

    const finished = exporter.getFinishedSpans()
    expect(finished).toHaveLength(1)
    expect(finished[0]?.name).toBe("graphql.OkTest")
    expect(finished[0]?.attributes["graphql.operation.name"]).toBe("OkTest")
    expect(finished[0]?.attributes["graphql.operation.type"]).toBe("mutation")
  })

  it("does not flip span status to ERROR when body throws BookingError", async () => {
    const schema = buildSchema()
    const result = await execute({
      schema,
      document: parse("mutation { boomTest { __typename ... on BookingError { code } } }"),
    })
    await provider.forceFlush()
    // Sanity — confirms the BookingError envelope arm fired.
    expect(result.errors).toBeUndefined()

    const finished = exporter.getFinishedSpans()
    expect(finished).toHaveLength(1)
    expect(finished[0]?.name).toBe("graphql.BoomTest")
    // Default code is UNSET (0); ERROR is 2. We require it to stay 0.
    expect(finished[0]?.status.code).toBe(0)
    // No `exception` event because BookingError is a typed wire-side
    // failure, not an unexpected throw.
    expect(finished[0]?.events.some((e) => e.name === "exception")).toBe(false)
  })
})
