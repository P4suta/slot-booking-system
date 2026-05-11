/**
 * Resolve the queue REST/WebSocket base URL.
 *
 * Local dev: `vite.config.ts` proxies `/api/*` (REST + WebSocket
 * upgrade) onto the wrangler dev worker — same-origin, so the
 * `__Host-staff_session` cookie issued by `POST /api/v1/staff/login`
 * is preserved across requests and the WS `/queue/feed` upgrade
 * tags the socket with the staff capability (ADR-0083 part 2 /
 * ADR-0085).
 *
 * Production: same Cloudflare zone, also same-origin.
 *
 * The `PUBLIC_API_BASE` escape hatch stays for one-off setups
 * that need a non-proxied target.
 */
export const apiBaseUrl = (): string => {
  if (typeof window !== "undefined") {
    const fromEnv = (import.meta.env.PUBLIC_API_BASE as string | undefined) ?? null
    if (fromEnv !== null && fromEnv.length > 0) return fromEnv.replace(/\/+$/, "")
  }
  return ""
}
