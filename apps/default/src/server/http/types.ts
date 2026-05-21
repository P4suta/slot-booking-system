import type { QueueShop } from "../durableObjects/QueueShop.js"

/**
 * The shape of a Cloudflare rate-limit binding (`[[unsafe.bindings]]
 * type = "ratelimit"`). Optional on the Env type because Miniflare
 * does not implement `unsafe.bindings`, so under `wrangler dev
 * --local` the field is `undefined` and the middleware fails open.
 */
export type RateLimitBinding = {
  readonly limit: (args: { readonly key: string }) => Promise<{ readonly success: boolean }>
}

/**
 * Cloudflare Workers binding shape for the Hono app's
 * `Env["Bindings"]`. Mirrors the runtime `env` argument the worker's
 * `fetch` handler receives — Hono uses this to type `c.env` across
 * every handler so route bodies need no per-handler casts.
 */
export type Env = {
  readonly DB: D1Database
  readonly QUEUE_SHOP: DurableObjectNamespace<QueueShop>
  readonly DEPLOYMENT_NAME: string
  readonly DEPLOYMENT_TIMEZONE?: string
  readonly IS_DEV?: string
  readonly OTEL_EXPORTER_URL?: string
  readonly OTEL_EXPORTER_KEY?: string
  readonly STAFF_SESSION_SECRET?: string
  readonly NO_SHOW_TIMEOUT_SECONDS?: string
  readonly ALLOWED_ORIGINS?: string
  readonly SLOT_DEFAULT_CAPACITY?: string
  readonly SLOT_DEFAULT_GRANULARITY?: string
  readonly EDF_GRACE_MINUTES?: string
  // Rate-limit bindings (ADR-0057). Optional because Miniflare's
  // `wrangler dev --local` does not implement `[[unsafe.bindings]]`;
  // production binds all three.
  readonly RL_ISSUE?: RateLimitBinding
  readonly RL_OPERATE?: RateLimitBinding
  readonly RL_VERIFY?: RateLimitBinding
}
