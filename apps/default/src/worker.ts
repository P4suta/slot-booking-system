interface Env {
  DB: D1Database
  DEPLOYMENT_NAME: string
  DEPLOYMENT_TIMEZONE: string
}

// Phase 0.4 sanity stub. Real wiring (Effect runtime, BookingRepository
// adapter, slot routes, …) lands in Phase 1.
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === "/healthz") {
      return new Response("ok", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      })
    }
    const body = JSON.stringify(
      {
        deployment: env.DEPLOYMENT_NAME,
        timezone: env.DEPLOYMENT_TIMEZONE,
        message: "phase 0 sanity — wiring lands in phase 1",
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
