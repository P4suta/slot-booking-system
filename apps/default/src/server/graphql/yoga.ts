import { trace } from "@opentelemetry/api"
import { GraphQLError } from "graphql"
import { createYoga, type Plugin } from "graphql-yoga"
import type { DaySchedule } from "../durableObjects/DaySchedule.js"
import type { GraphQLContext } from "./context.js"
import { schema } from "./schema.js"

type Env = {
  readonly DB: D1Database
  readonly DAY_SCHEDULE: DurableObjectNamespace<DaySchedule>
  readonly DEPLOYMENT_TIMEZONE: string
  readonly SLOT_HMAC_SECRET: string
}

type DomainErrorExtensions = {
  readonly __typename?: unknown
  readonly code?: unknown
  readonly severity?: unknown
}

type TaggedOriginal = {
  readonly _tag?: unknown
}

const asString = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined)

const extensionsOf = (err: GraphQLError): DomainErrorExtensions =>
  err.extensions as DomainErrorExtensions

const tagOf = (err: GraphQLError): string | undefined => {
  const fromTypename = asString(extensionsOf(err).__typename)
  if (fromTypename !== undefined) return fromTypename
  const original = err.originalError as TaggedOriginal | null | undefined
  if (original === null || original === undefined) return undefined
  return asString(original._tag)
}

const isGraphQLErrorList = (v: unknown): v is readonly GraphQLError[] =>
  Array.isArray(v) && v.every((e: unknown) => e instanceof GraphQLError)

/**
 * Phase 2.6 / BI-9 — Yoga plugin that lifts the Pothos errors
 * plugin's typed `BookingError` extensions onto the active OTel
 * span as semconv `error.type` / `error.code` / `error.severity`
 * attributes plus a `recordException` event. The plugin is purely
 * additive: GraphQL response shape is unchanged, the operator just
 * gets one extra span event per failed operation correlated by the
 * inbound `traceparent` (or the `instrument(...)`-minted root span
 * when no header is present).
 */
const useDomainErrorTrace: Plugin = {
  onExecute() {
    return {
      onExecuteDone({ result }) {
        if (typeof result !== "object" || !("errors" in result)) return
        if (!isGraphQLErrorList(result.errors)) return
        const span = trace.getActiveSpan()
        if (span === undefined) return
        for (const err of result.errors) {
          const tag = tagOf(err)
          if (tag === undefined) continue
          const ext = extensionsOf(err)
          const code = asString(ext.code)
          const severity = asString(ext.severity)
          span.setAttribute("error.type", tag)
          if (code !== undefined) span.setAttribute("error.code", code)
          if (severity !== undefined) span.setAttribute("error.severity", severity)
          span.recordException({ name: tag, message: err.message })
        }
      },
    }
  },
}

/**
 * GraphQL Yoga adapter for Cloudflare Workers. The per-request
 * `context` factory carries the Cloudflare bindings (D1, the
 * `DaySchedule` DO namespace) so each resolver can route reads to D1
 * and writes to the per-day actor.
 *
 * The Effect runtime that mutations need (Clock, IdGenerator, …) lives
 * inside the DurableObject — resolvers only need to know how to reach
 * the right DO. This keeps the Worker entry tiny and centralises the
 * Layer composition in one place (`DaySchedule.layer(...)`).
 */
export const yoga = createYoga<Env, GraphQLContext>({
  schema,
  graphqlEndpoint: "/graphql",
  landingPage: false,
  graphiql: { defaultQuery: "{ __schema { types { name } } }" },
  plugins: [useDomainErrorTrace],
  context: (initial): GraphQLContext => ({
    env: {
      DB: initial.DB,
      DAY_SCHEDULE: initial.DAY_SCHEDULE,
      DEPLOYMENT_TIMEZONE: initial.DEPLOYMENT_TIMEZONE,
      SLOT_HMAC_SECRET: initial.SLOT_HMAC_SECRET,
    },
    request: initial.request,
  }),
})
