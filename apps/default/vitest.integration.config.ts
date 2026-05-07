import { cloudflarePool } from "@cloudflare/vitest-pool-workers"
import { defineConfig } from "vitest/config"

/**
 * Phase 2.9 BI-10 carry-over (ADR-0037 deferred): Miniflare-isolated
 * integration suite. `cloudflarePool` boots a workerd isolate per
 * test file with the bindings declared in `wrangler.toml`
 * (`DAY_SCHEDULE` DurableObject + `DB` D1). Tests under
 * `test/integration/` use `cloudflare:test`'s `runInDurableObject`
 * to assert real DO behaviour — event-source replay across
 * `ctx.abort()`, OTel context propagation through the workerd
 * tracer, etc.
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
    poolRunner: cloudflarePool({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        compatibilityFlags: ["nodejs_compat", "experimental"],
      },
    }),
  },
})
