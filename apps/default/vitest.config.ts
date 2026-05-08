import { defineConfig } from "vitest/config"

/**
 * Vitest is split into two projects so the pure-Node tests (worker
 * entry config, JWT round-trip, session crypto) do not have to
 * pay the Miniflare boot cost, while the integration tests under
 * `test/integration/**` run inside the Cloudflare Workers runtime
 * (`@cloudflare/vitest-pool-workers`) with full DO + binding
 * semantics.
 *
 *   - `node` project: pre-existing tests under `test/**` minus the
 *     integration directory. environment: "node", standard vitest.
 *   - `workers` project: integration tests, runtime provided by
 *     the workers pool. Pool reads `wrangler.toml` for binding
 *     shape (DO + D1 + unsafe rate limit) and spins up a Miniflare
 *     instance per test file.
 *
 * The `workers` project ships empty in C1 — only
 * `test/integration/.gitkeep` exists. Subsequent commits populate
 * `_harness/` + integration test files.
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
        test: {
          name: "workers",
          include: ["test/integration/**/*.integration.test.ts"],
          pool: "@cloudflare/vitest-pool-workers",
          poolOptions: {
            workers: {
              wrangler: { configPath: "./wrangler.toml" },
              miniflare: {
                compatibilityFlags: ["nodejs_compat"],
              },
            },
          },
        },
      },
    ],
  },
})
