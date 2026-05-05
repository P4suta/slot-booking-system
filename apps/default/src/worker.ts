import { yoga } from "./server/graphql/yoga.js"

interface Env {
  DB: D1Database
  DEPLOYMENT_NAME: string
  DEPLOYMENT_TIMEZONE: string
}

// Phase 0.5 entry. `/healthz` is the readiness probe; `/graphql` serves
// the Phase 0.5 GraphQL stub (Pothos schema + Yoga adapter, ADR-0025
// draft). Real wiring (Effect runtime, BookingRepository adapter, slot
// routes, …) lands in Phase 1.
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
        message: "phase 0.5 sanity — POST /graphql for the schema stub",
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
