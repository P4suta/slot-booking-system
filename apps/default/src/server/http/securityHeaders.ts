import type { Context, Next } from "hono"

/**
 * Strict baseline security headers for every JSON API response. The
 * API surface is JSON-only and never serves HTML, so the CSP locks
 * everything down to `default-src 'none'` + `frame-ancestors 'none'`
 * (defense in depth against MIME-confused responses being framed as
 * documents); STS is the longest reasonable preload window
 * (2 years), and `Permissions-Policy: ()` empties every browser
 * feature.
 *
 * Keep these synced with the OWASP Secure Headers project baseline.
 */
const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "strict-transport-security": "max-age=63072000; includeSubDomains; preload",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "permissions-policy": "()",
}

export const securityHeaders = async (c: Context, next: Next): Promise<void> => {
  await next()
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    c.res.headers.set(k, v)
  }
}

/**
 * Env-driven CORS allowlist. `ALLOWED_ORIGINS` is a comma-separated
 * list of exact-match origins; any unlisted Origin header is reflected
 * as `null` (preflight will fail at the browser). `IS_DEV === "1"`
 * widens to `*` so the apps/web Vite dev server (port 5173) can talk
 * to wrangler dev (port 8787) without per-host config.
 */
export const corsAllowlist = (
  isDev: boolean,
  allowed: ReadonlySet<string>,
): ((c: Context, next: Next) => Promise<undefined | Response>) => {
  return async (c, next) => {
    const origin = c.req.header("origin") ?? ""
    const allowOrigin = isDev ? "*" : allowed.has(origin) ? origin : ""
    if (c.req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": allowOrigin,
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "content-type, x-staff-token, authorization",
          "access-control-max-age": "86400",
        },
      })
    }
    await next()
    if (allowOrigin !== "") {
      c.res.headers.set("access-control-allow-origin", allowOrigin)
      c.res.headers.set("vary", "origin")
    }
    return undefined
  }
}

export const parseAllowlist = (csv: string | undefined): ReadonlySet<string> =>
  new Set(
    (csv ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  )
