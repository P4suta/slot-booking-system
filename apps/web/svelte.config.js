import adapter from "@sveltejs/adapter-cloudflare"
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte"

/**
 * SvelteKit 2.x with the unified Cloudflare adapter (replaces the
 * legacy `adapter-cloudflare-workers`). The adapter detects bindings
 * declared in `wrangler.toml` and threads them through `platform.env`
 * to load functions / endpoints.
 *
 * Path aliases:
 *   - `$booking-core` re-exports the workspace package without the
 *     scoped name in the editor; the production bundle still goes
 *     through pnpm's workspace resolution. Phase 0.11 wires GraphQL
 *     calls through the alias so the import path stays stable while
 *     the package internals evolve.
 *
 * @type {import("@sveltejs/kit").Config}
 */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter(),
    alias: {
      "$booking-core": "../../packages/core/dist/index.js",
    },
  },
}

export default config
