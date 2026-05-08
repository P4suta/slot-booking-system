import { cloudflareTest } from "@cloudflare/vitest-pool-workers"
import { defineConfig } from "vitest/config"

/**
 * Vitest is split into two projects so the pure-Node tests (worker
 * entry config, JWT round-trip, session crypto) do not have to
 * pay the Miniflare boot cost, while the integration tests under
 * `test/integration/**` run inside the Cloudflare Workers runtime
 * via the `cloudflareTest` Vite plugin (vitest-pool-workers ≥
 * 0.16, the v4 plugin-based API).
 *
 *   - `node` project: pre-existing tests under `test/**` minus the
 *     integration directory. environment: "node", standard vitest.
 *   - `workers` project: integration tests, runtime provided by
 *     the `cloudflareTest` plugin which spins up a Miniflare
 *     instance per worker and bridges it with vitest. Reads
 *     `wrangler.toml` for binding shape (DO + D1 + unsafe rate
 *     limit).
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          include: ["test/**/*.test.ts"],
          exclude: ["test/integration/**", "node_modules/**"],
          environment: "node",
        },
      },
      {
        plugins: [
          cloudflareTest({
            main: "./src/worker.ts",
            wrangler: { configPath: "./wrangler.toml" },
            miniflare: {
              compatibilityFlags: ["nodejs_compat"],
            },
          }),
        ],
        test: {
          name: "workers",
          include: ["test/integration/**/*.integration.test.ts"],
          setupFiles: ["./test/integration/_harness/teardown.ts"],
        },
      },
    ],
  },
})
