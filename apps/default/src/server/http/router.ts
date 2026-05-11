/**
 * Hono-based queue REST surface. The router is a thin facade over
 * the {@link ROUTES} table — every endpoint body lives in
 * `routes.ts` as a {@link RouteDescriptor}; this module just wires
 * the global middlewares, the error envelope, and the descriptor
 * walk.
 *
 * Cross-cutting concerns (request log, security headers, CORS
 * allowlist, envelope-log, onError) are applied once to the
 * {@link Hono} app. Per-endpoint rate-limit middlewares are
 * attached by `registerRoute` from the descriptor's `rateLimit`
 * field.
 *
 * Endpoints (all `/api/v1` prefixed): see `routes.ts` —
 * each descriptor has a heading comment describing its role.
 */
import { Hono } from "hono"
import { registerRoutes } from "./dispatchRoute.js"
import { envelopeLog } from "./envelopeLog.js"
import { onError } from "./onError.js"
import { requestLog } from "./requestLog.js"
import { ROUTES } from "./routes.js"
import { corsAllowlist, parseAllowlist, securityHeaders } from "./securityHeaders.js"
import type { Env } from "./types.js"

export const buildQueueApi = (): Hono<{ Bindings: Env }> => {
  const app = new Hono<{ Bindings: Env }>()

  app.use("*", requestLog)
  app.use("*", securityHeaders)
  app.use("*", async (c, next) => {
    const allowed = parseAllowlist(c.env.ALLOWED_ORIGINS)
    const cors = corsAllowlist(c.env.IS_DEV === "1", allowed)
    return cors(c as never, next)
  })
  app.use("*", envelopeLog)
  app.onError(onError)

  registerRoutes(app, ROUTES)

  return app
}
