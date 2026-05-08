import { PiiPurger, SystemClockLive } from "@booking/core"
import { instrument, type ResolveConfigFn } from "@microlabs/otel-cf-workers"
import { Duration, Effect, Layer } from "effect"
import { makeD1AuditLogger } from "./server/adapters/D1AuditLoggerLive.js"
import { makeD1PiiPurger } from "./server/adapters/D1PiiPurgerLive.js"
import { makeRuntimeModeLayer } from "./server/adapters/RuntimeModeLive.js"
import { WorkersLoggerLive } from "./server/adapters/WorkersLoggerLive.js"
import { routeQueueApi } from "./server/api/queue.js"
import type { QueueShop } from "./server/durableObjects/QueueShop.js"
import { chooseExporter } from "./server/observability/otelConfig.js"

export { QueueShop } from "./server/durableObjects/QueueShop.js"

type Env = {
  DB: D1Database
  QUEUE_SHOP: DurableObjectNamespace<QueueShop>
  DEPLOYMENT_NAME: string
  DEPLOYMENT_TIMEZONE: string
  IS_DEV?: string
  OTEL_EXPORTER_URL?: string
  OTEL_EXPORTER_KEY?: string
  STAFF_SESSION_SECRET?: string
  NO_SHOW_TIMEOUT_SECONDS?: string
}

const TWO_YEARS = Duration.days(365 * 2)

/**
 * Worker entry. Routes:
 *   - GET  /healthz       readiness probe
 *   - *    /api/v1/...    queue REST + SSE surface
 *
 * The QueueShop DurableObject (single instance, idFromName("shop"))
 * is exported so wrangler can construct it. The scheduled handler
 * runs the daily PII-purge over the D1 mirror (ADR-0009).
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
    if (url.pathname.startsWith("/api/v1/")) {
      const handled = await routeQueueApi(request, env)
      if (handled !== null) return handled
    }
    const body = JSON.stringify(
      {
        deployment: env.DEPLOYMENT_NAME,
        timezone: env.DEPLOYMENT_TIMEZONE,
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
    const auditLayer = makeD1AuditLogger(env.DB).pipe(Layer.provide(WorkersLoggerLive))
    const layer = Layer.mergeAll(
      makeD1PiiPurger(env.DB),
      auditLayer,
      SystemClockLive,
      WorkersLoggerLive,
      makeRuntimeModeLayer(env),
    )
    const purge = Effect.gen(function* () {
      const purger = yield* PiiPurger
      yield* purger.purgeOlderThan(TWO_YEARS)
    })
    await Effect.runPromise(purge.pipe(Effect.provide(layer)))
  },
} satisfies ExportedHandler<Env>

const otelConfig: ResolveConfigFn<Env> = (env) => ({
  service: { name: env.DEPLOYMENT_NAME, version: "0.0.0" },
  exporter: chooseExporter(env),
})

export default instrument(handler, otelConfig)
