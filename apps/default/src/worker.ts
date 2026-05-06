import { PurgeStalePii, SystemClockLive } from "@booking/core"
import { Effect, Layer } from "effect"
import { makeD1AuditLogger } from "./server/adapters/D1AuditLoggerLive.js"
import { makeD1PiiPurger } from "./server/adapters/D1PiiPurgerLive.js"
import { WorkersLoggerLive } from "./server/adapters/WorkersLoggerLive.js"
import type { DaySchedule } from "./server/durableObjects/DaySchedule.js"
import { yoga } from "./server/graphql/yoga.js"

export { DaySchedule } from "./server/durableObjects/DaySchedule.js"

type Env = {
  DB: D1Database
  DAY_SCHEDULE: DurableObjectNamespace<DaySchedule>
  DEPLOYMENT_NAME: string
  DEPLOYMENT_TIMEZONE: string
  SLOT_HMAC_SECRET: string
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
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === "/healthz") {
      return new Response("ok", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
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
    const layer = Layer.mergeAll(
      makeD1PiiPurger(env.DB),
      makeD1AuditLogger(env.DB),
      SystemClockLive,
      WorkersLoggerLive,
    )
    await Effect.runPromise(PurgeStalePii().pipe(Effect.provide(layer)))
  },
} satisfies ExportedHandler<Env>
