import type { Handle } from "@sveltejs/kit"
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
