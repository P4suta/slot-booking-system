import { svelte } from "@sveltejs/vite-plugin-svelte"
import { defineConfig } from "vitest/config"

export default defineConfig({
  // `.svelte.ts` Svelte 5 rune files (e.g. `lib/stores/shopState.svelte.ts`)
  // need the Svelte compiler to transform `$state`, `$derived`, `$effect`
  // into their runtime equivalents before vitest evaluates them. Without
  // the plugin the rune sigils survive into the executed JS and throw
  // `ReferenceError: $state is not defined`.
  plugins: [svelte({ hot: false })],
  test: {
    include: ["test/**/*.test.ts"],
    // See `packages/core/vitest.config.ts` for the rationale —
    // `streamReporter` emits CASE_START events for the wrapper's
    // heartbeat consumer.
    reporters: ["verbose", "../../scripts/test/streamReporter.ts"],
    environment: "node",
  },
})
