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
    // See `packages/core/vitest.config.ts` for the rationale —
    // `streamReporter` emits CASE_START events for the wrapper's
    // heartbeat consumer. Defined at the workspace root so both
    // projects (node + workers) share the same emit channel.
    reporters: ["verbose", "../../scripts/test/streamReporter.ts"],
    // vitest-pool-workers 0.16 leaks Miniflare-side timers /
    // sockets past `afterAll`; the host runner SIGTERMs once
    // every test reports passed. A short teardownTimeout
    // ensures vitest itself does not stall trying to await the
    // lingering handles before that SIGTERM lands.
    teardownTimeout: 5000,
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
              // STAFF_SESSION_SECRET is normally injected via
              // `.dev.vars` for `wrangler dev` (and via
              // `wrangler secret put` in prod). Miniflare under
              // vitest-pool-workers does not pick `.dev.vars` up,
              // so `requireStaff` would return 503 `absent` for
              // every staff-touching request. The value mirrors
              // the `SECRET` literal each integration test file
              // signs its `staffHeaders()` envelope with, so
              // both ends of the JWT / session-cookie round-trip
              // see the same key.
              bindings: {
                STAFF_SESSION_SECRET:
                  "dev-local-secret-do-not-use-in-prod-32bytes-hex-cafebabedeadbeef",
              },
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
