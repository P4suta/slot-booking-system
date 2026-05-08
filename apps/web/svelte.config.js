import adapter from "@sveltejs/adapter-cloudflare"
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte"

/**
 * SvelteKit 2.x with the unified Cloudflare adapter. The adapter
 * detects bindings declared in `wrangler.toml` and threads them
 * through `platform.env` to load functions / endpoints. The
 * `$booking-core` alias re-exports the workspace package so the
 * import path stays stable while the package internals evolve.
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
