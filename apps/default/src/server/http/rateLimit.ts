import type { Context, Next } from "hono"
import type { Env } from "./types.js"

/**
 * Cloudflare Workers rate-limit binding wrapper. The binding shape
 * `{ limit(args): Promise<{ success: boolean }> }` is the runtime
 * surface produced by `[[unsafe.bindings]] type = "ratelimit"`
 * (Cloudflare docs); the binding is tied to a namespace_id +
 * (limit, period) tuple defined in wrangler.toml.
 *
 * Two namespaces ship by default:
 *
 *   - RL_ISSUE (60 / minute): customer-side ticket issue, scoped
 *     per CF-Connecting-IP so a single client cannot starve the
 *     queue. Tuned to roughly one ticket every two seconds, which
 *     dwarfs realistic human walk-up cadence.
 *   - RL_OPERATE (300 / minute): staff-side mutations, scoped per
 *     staff-token hash. A burst of repeated clicks during a busy hour
 *     should not trip the limit; a runaway script will.
 *
 * Miniflare does not implement `[[unsafe.bindings]]` so the binding
 * is `undefined` under `wrangler dev --local` — the middleware
 * fails open in that case (development convenience). Production
 * rejects with 429 + Retry-After.
 */

type RateLimitBinding = {
  readonly limit: (args: { key: string }) => Promise<{ success: boolean }>
}

export type RateLimitNamespace = "RL_ISSUE" | "RL_OPERATE"

const KEY_FNS: Record<RateLimitNamespace, (c: Context<{ Bindings: Env }>) => string> = {
  RL_ISSUE: (c) => c.req.header("cf-connecting-ip") ?? "anonymous",
  RL_OPERATE: (c) => c.req.header("x-staff-token") ?? "no-token",
}

const RETRY_AFTER_SECONDS = 60

const getBinding = (
  c: Context<{ Bindings: Env }>,
  ns: RateLimitNamespace,
): RateLimitBinding | undefined => {
  // The binding type is opaque; treat the env access as a runtime
  // probe so wrangler-dev (no binding) and production (real
  // binding) both compile.
  const env = c.env as unknown as Record<string, RateLimitBinding | undefined>
  return env[ns]
}

export const rateLimitMiddleware = (
  ns: RateLimitNamespace,
): ((c: Context<{ Bindings: Env }>, next: Next) => Promise<Response | undefined>) => {
  return async (c, next) => {
    const binding = getBinding(c, ns)
    if (binding === undefined) {
      // Miniflare / dev-only path: no binding, fail-open.
      await next()
      return undefined
    }
    const key = KEY_FNS[ns](c)
    const result = await binding.limit({ key })
    if (!result.success) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: { _tag: "RateLimited", code: "E_INF_RATE_LIMITED", namespace: ns },
        }),
        {
          status: 429,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "retry-after": String(RETRY_AFTER_SECONDS),
          },
        },
      )
    }
    await next()
    return undefined
  }
}
