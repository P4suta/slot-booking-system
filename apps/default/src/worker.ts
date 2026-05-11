import { PiiPurger, SystemClockLive } from "@booking/core"
import { instrument, type ResolveConfigFn } from "@microlabs/otel-cf-workers"
import { Duration, Effect, Layer } from "effect"
import { makeD1AuditLogger } from "./server/adapters/D1AuditLoggerLive.js"
import { makeD1PiiPurger } from "./server/adapters/D1PiiPurgerLive.js"
import { makeRuntimeModeLayer } from "./server/adapters/RuntimeModeLive.js"
import { WorkersLoggerLive } from "./server/adapters/WorkersLoggerLive.js"
import { isDevMode } from "./server/http/errorEnvelope.js"
import { buildQueueApi } from "./server/http/router.js"
import type { Env } from "./server/http/types.js"
import { __setDevLogPublisher } from "./server/obs/devLogTap.js"
import { chooseExporter } from "./server/observability/otelConfig.js"

export { DevLogStream } from "./server/durableObjects/DevLogStream.js"
export { QueueShop } from "./server/durableObjects/QueueShop.js"

const TWO_YEARS = Duration.days(365 * 2)

const queueApi = buildQueueApi()

/**
 * Worker entry. Routes:
 *   - GET  /healthz       readiness probe
 *   - *    /api/v1/...    queue REST + SSE surface (Hono-mounted)
 *
 * The QueueShop DurableObject (single instance, idFromName("shop"))
 * is exported so wrangler can construct it. The scheduled handler
 * runs the daily PII-purge over the D1 mirror (ADR-0009).
 */
const handler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Stage 22b cont. / ADR-0091 — wire the dev-log relay on every
    // fetch when the deployment is in dev mode. The publisher
    // captures every structured-log line emitted during the
    // request (HttpRequest / HttpEnvelope / ClientReport /
    // WorkersLoggerLive output) and RPCs it into the DevLogStream
    // DO's in-memory ring so any client attached to
    // `/api/v1/__/dev/log-stream` sees it live. Setting the
    // publisher on every fetch is cheap (one closure + one stub
    // lookup) and tolerates module-state staleness across isolate
    // reuse without conditional re-bind logic.
    if (isDevMode(env)) {
      const devLogStub = env.DEV_LOG_STREAM.get(env.DEV_LOG_STREAM.idFromName("main"))
      __setDevLogPublisher((entry) => {
        void devLogStub.publishLog(entry)
      })
    } else {
      __setDevLogPublisher(null)
    }
    const url = new URL(request.url)
    if (url.pathname === "/healthz") {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      })
    }
    if (url.pathname.startsWith("/api/v1/")) {
      return queueApi.fetch(request, env)
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
    const startedAt = Date.now()
    console.warn(
      JSON.stringify({
        _tag: "ScheduledStart",
        code: "I_SCHEDULED_START",
        severity: "infrastructure",
        deployment: env.DEPLOYMENT_NAME,
      }),
    )
    const purge = Effect.gen(function* () {
      const purger = yield* PiiPurger
      yield* purger.purgeOlderThan(TWO_YEARS)
    })
    try {
      await Effect.runPromise(purge.pipe(Effect.provide(layer)))
      console.warn(
        JSON.stringify({
          _tag: "ScheduledEnd",
          code: "I_SCHEDULED_END",
          severity: "infrastructure",
          deployment: env.DEPLOYMENT_NAME,
          ms: Date.now() - startedAt,
        }),
      )
    } catch (err) {
      console.error(
        JSON.stringify({
          _tag: "ScheduledError",
          code: "I_SCHEDULED_ERROR",
          severity: "infrastructure",
          deployment: env.DEPLOYMENT_NAME,
          ms: Date.now() - startedAt,
          message: err instanceof Error ? err.message : String(err),
        }),
      )
      throw err
    }
  },
} satisfies ExportedHandler<Env>

const otelConfig: ResolveConfigFn<Env> = (env) => ({
  service: { name: env.DEPLOYMENT_NAME, version: "0.0.0" },
  exporter: chooseExporter(env),
})

export default instrument(handler, otelConfig)
