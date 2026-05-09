/**
 * Resolve the queue REST/WebSocket base URL.
 *
 * Local dev: SvelteKit (5173) calls the worker on a different port
 * (`PUBLIC_API_BASE` or 8787). Production: same Cloudflare zone, so
 * `/api/v1` is same-origin and no env var is needed.
 */
export const apiBaseUrl = (): string => {
  if (typeof window !== "undefined") {
    const fromEnv = (import.meta.env.PUBLIC_API_BASE as string | undefined) ?? null
    if (fromEnv !== null && fromEnv.length > 0) return fromEnv.replace(/\/+$/, "")
    if (window.location.hostname === "localhost") return "http://localhost:8787"
  }
  return ""
}
