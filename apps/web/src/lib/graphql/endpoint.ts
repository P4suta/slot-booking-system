/**
 * Resolve the GraphQL endpoint for the running deployment.
 *
 * Local dev: SvelteKit runs on port 5173, the Worker on port 8787, so
 * the page calls the worker over CORS. Production: the SvelteKit
 * worker and the booking worker share the same Cloudflare zone, and
 * the Pages adapter forwards `/graphql` on a path basis (see
 * `wrangler.toml` `[routes]`). Until that wiring lands, the env var
 * `PUBLIC_GRAPHQL_ENDPOINT` is the override.
 */

export const graphqlEndpoint = (): string => {
  if (typeof window !== "undefined") {
    const fromEnv = (import.meta.env.PUBLIC_GRAPHQL_ENDPOINT as string | undefined) ?? null
    if (fromEnv !== null && fromEnv.length > 0) return fromEnv
    if (window.location.hostname === "localhost") return "http://localhost:8787/graphql"
  }
  return "/graphql"
}
