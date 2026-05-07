import { cloudflareTest } from "@cloudflare/vitest-pool-workers"
import { defineConfig } from "vitest/config"

/**
 * Phase 2.9 BI-10 carry-over (ADR-0037 closure): Miniflare-isolated
 * integration suite. The `cloudflareTest` plugin wires Vite's
 * `resolveId` for the `cloudflare:test` virtual module AND swaps in
 * the `cloudflare-pool` runner.
 *
 * `main` is overridden to `test/integration/worker.entry.ts` — a
 * minimal entry that exports `DaySchedule` only. The production
 * worker (`src/worker.ts`) imports the full Yoga / Pothos pipeline,
 * which the integration suite doesn't need (the schema build is
 * exercised by the smoke / e2e suites elsewhere).
 *
 * Default (`pnpm test`) runs the node-environment shape contracts in
 * `test/effectRpc/`. Integration (`pnpm test:integration`) runs this
 * config separately because workerd boot adds ~3s per test file —
 * keeps the inner loop fast while still exercising the real binding
 * surface end-to-end.
 */
export default defineConfig({
  test: {
    include: ["test/integration/**/*.test.ts"],
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      main: "test/integration/worker.entry.ts",
      miniflare: {
        compatibilityFlags: ["nodejs_compat", "experimental"],
      },
    }),
  ],
})
