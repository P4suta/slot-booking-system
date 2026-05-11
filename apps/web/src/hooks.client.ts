import type { HandleClientError } from "@sveltejs/kit"
import { obsBus } from "$lib/obs/bus.js"
import { generateTraceId } from "$lib/obs/traceId.js"

/**
 * Client-side error boundary (Stage 24 / ADR-0094).
 *
 * SvelteKit calls this hook for every uncaught error thrown
 * inside a `+page.svelte` / `+layout.svelte` lifecycle or load
 * function. The hook is the single funnel point that:
 *
 *   1. mints a fresh trace id (the OTel span we use server-side
 *      is invisible to the browser, and a runtime error reaching
 *      here may not have a server origin at all);
 *   2. emits an `UncaughtError` through `obsBus` — the bus's
 *      default severity for the kind is `error`, which the
 *      reporter forwards to `/api/v1/__/client-error` (S22a)
 *      and the dev relay (S22 cont.) fans into `/dev/inspect`;
 *   3. returns the `App.Error` SvelteKit hands to
 *      `+error.svelte` so the customer sees a sanitized message
 *      plus the trace id they can quote back to support.
 *
 * The hook does NOT swallow the original error — SvelteKit
 * continues to render `+error.svelte` for the boundary, and a
 * `console.error` falls through to the obs ring's global error
 * listener as a safety net.
 */
export const handleError: HandleClientError = ({ error, event, status, message }) => {
  const traceId = generateTraceId()
  const detail = error instanceof Error ? error.message : String(error)
  const stack = error instanceof Error ? (error.stack ?? null) : null
  obsBus.emit({
    kind: "UncaughtError",
    message: `${event.url.pathname}: ${detail}`,
    stack,
    at: Date.now(),
  })
  return {
    message: status >= 500 ? "予期しないエラーが発生しました。" : message,
    traceId,
  }
}
