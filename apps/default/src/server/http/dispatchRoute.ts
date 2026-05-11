/**
 * `dispatchRoute` — the Hono-adapter combinator that turns a
 * declarative {@link RouteDescriptor} into an `app.get` / `app.post`
 * registration (S16 / ADR-0084).
 *
 * Each route is a record of:
 *   - HTTP method + path,
 *   - optional rate-limit namespace (`RL_ISSUE` / `RL_VERIFY` /
 *     `RL_OPERATE`),
 *   - the request-scoped `handle: (c: Context<{Bindings: Env}>) =>
 *     Response | Promise<Response>` callback.
 *
 * Listing every endpoint as a value in `routes.ts` gives:
 *   1. one source of truth a `for…of registerRoutes` consumer
 *      (the production router + the OpenAPI generator) can walk;
 *   2. lint-friendly path coverage — the OpenAPI builder fails if
 *      a route is missing a documented response;
 *   3. a single place to add cross-cutting concerns (tracing
 *      shape, response-time histogram) without touching 21
 *      handler bodies.
 */
import type { Context, Hono } from "hono"
import { type RateLimitNamespace, rateLimitMiddleware } from "./rateLimit.js"
import type { Env } from "./types.js"

export type RouteContext = Context<{ Bindings: Env }>

export type RouteDescriptor = {
  readonly method: "GET" | "POST"
  readonly path: string
  readonly rateLimit?: RateLimitNamespace
  readonly handle: (c: RouteContext) => Response | Promise<Response>
}

const registerRoute = (app: Hono<{ Bindings: Env }>, route: RouteDescriptor): void => {
  const middleware =
    route.rateLimit !== undefined ? rateLimitMiddleware(route.rateLimit) : undefined
  if (route.method === "GET") {
    if (middleware !== undefined) {
      app.get(route.path, middleware, route.handle)
    } else {
      app.get(route.path, route.handle)
    }
    return
  }
  if (middleware !== undefined) {
    app.post(route.path, middleware, route.handle)
  } else {
    app.post(route.path, route.handle)
  }
}

export const registerRoutes = (
  app: Hono<{ Bindings: Env }>,
  routes: readonly RouteDescriptor[],
): void => {
  for (const route of routes) registerRoute(app, route)
}
