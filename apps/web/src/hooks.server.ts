import type { Handle } from "@sveltejs/kit"
import { paraglideMiddleware } from "./paraglide/server.js"

/**
 * Phase 3 / SvelteKit + paraglide-js SSR locale wiring.
 *
 * `paraglideMiddleware` reads the locale from the incoming request
 * (URL prefix → cookie → `Accept-Language` → base locale per the
 * `strategy` set in `apps/web/src/paraglide/runtime.js`) and pins
 * it on `AsyncLocalStorage` for the lifetime of the request, so any
 * `m.<key>()` call from `import { m } from "$lib/.../paraglide/messages.js"`
 * inside server-rendered Svelte components resolves the right locale
 * even under concurrent SSR. The locale also lands on
 * `event.locals.lang` so route load functions can branch without
 * re-running the strategy chain.
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
