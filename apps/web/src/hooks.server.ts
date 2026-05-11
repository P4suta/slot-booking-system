import type { Handle, HandleServerError } from "@sveltejs/kit"
import { generateTraceId } from "$lib/obs/traceId.js"
import { paraglideMiddleware } from "./paraglide/server.js"

/**
 * SvelteKit + paraglide-js SSR locale wiring. `paraglideMiddleware`
 * reads the locale (URL prefix → cookie → `Accept-Language` → base
 * locale) and pins it on `AsyncLocalStorage` for the request, so
 * `m.<key>()` calls in server-rendered Svelte components resolve the
 * right locale even under concurrent SSR. The locale also lands on
 * `event.locals.lang` so route loaders can branch without re-running
 * the strategy chain.
 */
export const handle: Handle = ({ event, resolve }) =>
  paraglideMiddleware(event.request, ({ request, locale }) => {
    event.request = request
    event.locals.lang = locale
    return resolve(event, {
      transformPageChunk: ({ html }) =>
        html.replace(/<html\b[^>]*lang="[^"]*"/, `<html lang="${locale}"`),
    })
  })

/**
 * Server-side error boundary (Stage 24 / ADR-0094).
 *
 * SvelteKit calls this for every uncaught error during SSR
 * (load functions, +server endpoints). The hook mints a fresh
 * trace id so `+error.svelte` can render it for the customer —
 * the SvelteKit adapter on Cloudflare Workers runs outside the
 * worker's `@microlabs/otel-cf-workers` instrumentation chain,
 * so the underlying `currentTraceId` we use elsewhere is not
 * reachable from here. The structured log line goes to
 * `console.error` so production's Workers Logs sink ingests it
 * alongside the rest of the error envelope (the upstream API
 * call that triggered the SSR throw already has its own trace
 * id on the operator dashboard; this id correlates the
 * customer-facing render).
 */
export const handleError: HandleServerError = ({ error, event, status, message }) => {
  const traceId = generateTraceId()
  const detail = error instanceof Error ? error.message : String(error)
  console.error(
    JSON.stringify({
      _tag: "SvelteKitSsrError",
      code: "I_SVELTEKIT_SSR_ERROR",
      severity: "infrastructure",
      traceId,
      status,
      path: event.url.pathname,
      message: detail,
    }),
  )
  return {
    message: status >= 500 ? "予期しないエラーが発生しました。" : message,
    traceId,
  }
}
