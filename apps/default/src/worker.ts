import { yoga } from "./server/graphql/yoga.js"

export { DaySchedule } from "./server/durableObjects/DaySchedule.js"

type Env = {
  DB: D1Database
  DAY_SCHEDULE: DurableObjectNamespace
  DEPLOYMENT_NAME: string
  DEPLOYMENT_TIMEZONE: string
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
} satisfies ExportedHandler<Env>
