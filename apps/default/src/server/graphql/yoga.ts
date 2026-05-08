import {
  devRedactCause,
  type ErrorSeverity,
  errorToGraphQLExtensions,
  prodRedactCause,
  prodSamplingRates,
} from "@booking/core"
import { trace } from "@opentelemetry/api"
import { GraphQLError } from "graphql"
import { createYoga, type Plugin } from "graphql-yoga"
import type { DaySchedule } from "../durableObjects/DaySchedule.js"
import type { GraphQLContext } from "./context.js"
import { operationLogPlugin } from "./plugins/operationLogPlugin.js"
import { schema } from "./schema.js"

type Env = {
  readonly DB: D1Database
  readonly DAY_SCHEDULE: DurableObjectNamespace<DaySchedule>
  readonly DEPLOYMENT_TIMEZONE: string
  readonly SLOT_HMAC_SECRET: string
  readonly IS_DEV?: string
}

/**
 * Resolve the per-request cause redactor from the worker `env`. We
 * read `env.IS_DEV` directly instead of routing through the
 * {@link ErrorRedaction} port + Effect runtime — yoga's plugin chain
 * is synchronous and the env-indexed cleavage is an evaluation of the
 * exact same boolean. The two redactor implementations are imported
 * from `@booking/core` so the dev/prod variants stay pinned to the
 * categorical port (ADR-0043) rather than diverging here.
 */
const redactorFor = (env: Env): GraphQLContext["redactCause"] =>
  env.IS_DEV === "1" ? devRedactCause : prodRedactCause

const modeOf = (env: Env): "dev" | "prod" => (env.IS_DEV === "1" ? "dev" : "prod")

const decideAtRate = (rate: number): boolean => {
  if (rate >= 1) return true
  if (rate <= 0) return false
  return Math.random() < rate
}

/**
 * Build the operation-log emitter from the worker `env`. Dev mode
 * passes everything to `console.info`; prod mode applies a
 * severity-indexed rate (table at `prodSamplingRates()`, ADR-0026
 * sampler shape). This is the sync mirror of the Effect-runtime
 * `LogSamplerLive` — both consume the same rate table so log
 * behaviour stays uniform whether the call site is the yoga plugin
 * (hot-path sync) or a use-case via the `LogSampler` port (Effect).
 */
const operationLogEmitFor = (env: Env) => {
  const mode = modeOf(env)
  const rates = prodSamplingRates()
  return (record: Readonly<Record<string, unknown>>) => {
    const severity = (record.severity as ErrorSeverity | undefined) ?? "domain"
    if (mode !== "dev" && !decideAtRate(rates[severity])) return
    // biome-ignore lint/suspicious/noConsole: structured access log sink — Workers Logs ingestion
    console.info(JSON.stringify(record))
  }
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
 * Phase 3 PR#8 — Yoga plugin that decorates `result.errors[].extensions`
 * with the `errorToGraphQLExtensions` derivation: in dev mode the
 * originating cause's `{ name, message, stack[0..3], originalTag? }`
 * preview shows up alongside `code` / `severity` / `i18nKey`; in prod
 * mode the redactor is identity-zero so the wire payload is unchanged.
 *
 * The plugin reconstructs each error via `new GraphQLError(...)` so
 * the `extensions` write is observed by yoga's serialiser (mutating
 * the existing instance is allowed but `setResult` requires a fresh
 * `ExecutionResult`, and the new errors slot in cleanly).
 *
 * The OTel side-effect plugin (`useDomainErrorTrace` below) is left
 * unchanged — it is purely additive on the span surface and ignores
 * the wire shape.
 */
const useDevErrorExtensions: Plugin<GraphQLContext> = {
  onExecute() {
    return {
      onExecuteDone({ result, setResult, args }) {
        if (typeof result !== "object" || !("errors" in result)) return
        if (!isGraphQLErrorList(result.errors)) return
        if (result.errors.length === 0) return
        const ctx = args.contextValue
        const decorated = result.errors.map((err) => {
          const cause = err.originalError ?? err
          const extras = errorToGraphQLExtensions(cause, ctx.redactCause)
          if (Object.keys(extras).length === 0) return err
          return new GraphQLError(err.message, {
            ...(err.nodes !== undefined ? { nodes: err.nodes } : {}),
            ...(err.source !== undefined ? { source: err.source } : {}),
            ...(err.positions !== undefined ? { positions: err.positions } : {}),
            ...(err.path !== undefined ? { path: err.path } : {}),
            originalError: err.originalError ?? err,
            extensions: { ...err.extensions, ...extras },
          })
        })
        setResult({ ...result, errors: decorated })
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
  plugins: [operationLogPlugin(), useDevErrorExtensions, useDomainErrorTrace],
  context: (initial): GraphQLContext => ({
    env: {
      DB: initial.DB,
      DAY_SCHEDULE: initial.DAY_SCHEDULE,
      DEPLOYMENT_TIMEZONE: initial.DEPLOYMENT_TIMEZONE,
      SLOT_HMAC_SECRET: initial.SLOT_HMAC_SECRET,
    },
    request: initial.request,
    redactCause: redactorFor(initial),
    runtimeMode: modeOf(initial),
    emitOperationLog: operationLogEmitFor(initial),
  }),
})
