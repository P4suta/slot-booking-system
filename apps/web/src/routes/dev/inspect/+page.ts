import { error } from "@sveltejs/kit"
import { dev } from "$app/environment"

/**
 * Dev-only inspector gate (Stage 23 / ADR-0092).
 *
 * `$app/environment.dev` is `true` during `vite dev` and `false`
 * in any production / preview build, so the surface is
 * undiscoverable to a prod deploy regardless of routing
 * shenanigans. The server-side WS upgrade (`IS_DEV === "1"` in
 * `routes.ts`) is the upstream gate — this one is a build-time
 * tree-shake that makes the bundle smaller in prod.
 */
export const load = (): Record<string, never> => {
  if (!dev) error(404, "Not Found")
  return {}
}
