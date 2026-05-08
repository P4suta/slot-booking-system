import { instrument, type ResolveConfigFn } from "@microlabs/otel-cf-workers"
import { chooseExporter } from "./server/observability/otelConfig.js"
import { buildOpenAPISpec } from "./server/rest/openapiSpec.js"

type Env = {
  DB: D1Database
  DEPLOYMENT_NAME: string
  DEPLOYMENT_TIMEZONE: string
  /**
   * `"1"` flips RuntimeMode to dev (verbose error extensions, permissive
   * log sampling, console OTel exporter). Anything else (including
   * missing) maps to prod. The `dev` script flips the bit via
   * `wrangler dev --var IS_DEV:1`.
   */
  IS_DEV?: string
  /**
   * Three-way exporter triage:
   *   - `"console"`              → ConsoleSpanExporter (stdout, dev local)
   *   - `"disabled"` (default in prod) → NoopSpanExporter (no traffic)
   *   - any other string         → OTLP HTTP endpoint URL
   */
  OTEL_EXPORTER_URL?: string
  /** Optional — vendor-specific auth header (e.g. Honeycomb / Axiom). */
  OTEL_EXPORTER_KEY?: string
}

/**
 * Phase 0 stub. The queue-pivot (ADR-0050) scrapped the slot-graph
 * domain and its Worker entry routes. Phase 2 reintroduces the
 * QueueShop Durable Object (single-writer actor for the FIFO queue),
 * Phase 3 the GraphQL surface (5 mutations / 2 queries / 1 SSE
 * subscription), Phase 4 the staff session auth flow.
 *
 * In the meantime the Worker exposes only:
 *   - `GET /healthz`               readiness probe
 *   - `GET /api/v1/openapi.json`   the OpenAPI 3.1 emission for `/healthz`
 *   - default JSON                 deployment metadata
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
    const body = JSON.stringify(
      {
        deployment: env.DEPLOYMENT_NAME,
        timezone: env.DEPLOYMENT_TIMEZONE,
        message:
          "queue pivot in progress — Phase 2 reintroduces the QueueShop DO + GraphQL surface",
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

const otelConfig: ResolveConfigFn<Env> = (env) => ({
  service: { name: env.DEPLOYMENT_NAME, version: "0.0.0" },
  exporter: chooseExporter(env),
})

export default instrument(handler, otelConfig)
