import { PurgeStalePii, SystemClockLive } from "@booking/core"
import { instrument, type ResolveConfigFn } from "@microlabs/otel-cf-workers"
import { Effect, Layer } from "effect"
import { makeD1AuditLogger } from "./server/adapters/D1AuditLoggerLive.js"
import { makeD1PiiPurger } from "./server/adapters/D1PiiPurgerLive.js"
import { makeRuntimeModeLayer } from "./server/adapters/RuntimeModeLive.js"
import { WorkersLoggerLive } from "./server/adapters/WorkersLoggerLive.js"
import type { DaySchedule } from "./server/durableObjects/DaySchedule.js"
import { yoga } from "./server/graphql/yoga.js"
import { buildOpenAPISpec } from "./server/rest/openapiSpec.js"

export { DaySchedule } from "./server/durableObjects/DaySchedule.js"

type Env = {
  DB: D1Database
  DAY_SCHEDULE: DurableObjectNamespace<DaySchedule>
  DEPLOYMENT_NAME: string
  DEPLOYMENT_TIMEZONE: string
  SLOT_HMAC_SECRET: string
  /**
   * `"1"` flips {@link RuntimeMode} to dev (verbose error extensions,
   * permissive log sampling, console OTel exporter). Anything else
   * (including missing) maps to prod. Wired via wrangler `[env.dev.vars]`
   * so `wrangler dev -e dev` is the only entry point that sees `"1"`.
   */
  IS_DEV?: string
  /** Optional — when set, OTLP traces are POSTed to this endpoint. */
  OTEL_EXPORTER_URL?: string
  /** Optional — vendor-specific auth header (e.g. Honeycomb / Axiom). */
  OTEL_EXPORTER_KEY?: string
}

/**
 * Phase 1 entry. Routes:
 *   - `GET  /healthz`   readiness probe
 *   - `*    /graphql`   Pothos schema served via GraphQL Yoga
 *   - default JSON      diagnostic body (deployment metadata)
 *
 * The `DaySchedule` Durable Object is exported from this module so
 * Wrangler can construct one per `(deployment, date)` tuple. Routes
 * that mutate bookings will resolve the DO via `env.DAY_SCHEDULE.get(...)`
 * and forward the parsed operation; the DO's actor model is what
 * serialises concurrent writes per day (ADR-0005).
 *
 * The `scheduled` handler runs the daily PII-purge job (ADR-0009 +
 * SYSTEM §6): any booking whose terminal timestamp is more than 2
 * years old has its `nameKana` / `phoneLast4` / `freeText` columns
 * NULL'd. Cron schedule lives in `wrangler.toml` `[triggers].crons`.
 *
 * **Phase 2.6 / BI-9 — observability** — the entry handler is wrapped
 * in `@microlabs/otel-cf-workers` `instrument(...)`, which:
 *   - Auto-accepts inbound `traceparent` (W3C Trace Context) headers
 *     and threads the trace context through the Effect runtime via
 *     `@opentelemetry/api`'s active span.
 *   - Auto-injects `traceparent` on outbound `fetch` calls so DO RPC
 *     and downstream services participate in the same trace.
 *   - Emits one root span per request / scheduled invocation. The
 *     domain layer adds child spans via `Telemetry.withSpan(...)`.
 *   - Posts spans to `OTEL_EXPORTER_URL` (optional) — falls back to
 *     `http://localhost:4318/v1/traces` for local-dev OTLP collection.
 *     Cloudflare's native Workers tracing remains active in parallel
 *     when no exporter is configured.
 */
const handler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === "/healthz") {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      })
    }
    if (url.pathname === "/api/v1/openapi.json") {
      return new Response(JSON.stringify(buildOpenAPISpec(), null, 2), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      })
    }
    if (url.pathname === "/graphql" || url.pathname.startsWith("/graphql?")) {
      return yoga.fetch(request, env)
    }
    const body = JSON.stringify(
      {
        deployment: env.DEPLOYMENT_NAME,
        timezone: env.DEPLOYMENT_TIMEZONE,
        message: "phase 1 — POST /graphql for the booking API",
      },
      null,
      2,
    )
    return new Response(body, {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    })
  },

  async scheduled(
    _controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    // Phase 2.6 / BI-9: D1AuditLoggerLive forwards write failures to
    // Logger, so the audit layer depends on Logger. Provide
    // WorkersLoggerLive into the audit layer explicitly before merging
    // — `Layer.mergeAll` does not resolve cross-layer dependencies.
    const auditLayer = makeD1AuditLogger(env.DB).pipe(Layer.provide(WorkersLoggerLive))
    const layer = Layer.mergeAll(
      makeD1PiiPurger(env.DB),
      auditLayer,
      SystemClockLive,
      WorkersLoggerLive,
      makeRuntimeModeLayer(env),
    )
    await Effect.runPromise(PurgeStalePii().pipe(Effect.provide(layer)))
  },
} satisfies ExportedHandler<Env>

const otelConfig: ResolveConfigFn<Env> = (env) => ({
  service: { name: env.DEPLOYMENT_NAME, version: "0.0.0" },
  exporter:
    env.OTEL_EXPORTER_URL !== undefined
      ? {
          url: env.OTEL_EXPORTER_URL,
          headers:
            env.OTEL_EXPORTER_KEY !== undefined
              ? { authorization: `Bearer ${env.OTEL_EXPORTER_KEY}` }
              : {},
        }
      : { url: "http://localhost:4318/v1/traces" },
})

export default instrument(handler, otelConfig)
