import type { QueueShop } from "../durableObjects/QueueShop.js"

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
  readonly GRACE_TTL_MIN?: string
  readonly ALLOWED_ORIGINS?: string
  readonly SLOT_DEFAULT_CAPACITY?: string
  readonly SLOT_DEFAULT_GRANULARITY?: string
  readonly EDF_GRACE_MINUTES?: string
  readonly BUSINESS_HOURS_START_MIN?: string
  readonly BUSINESS_HOURS_END_MIN?: string
  readonly SERVING_THRESHOLD_MS?: string
  readonly BROADCAST_COALESCE_MS?: string
}
