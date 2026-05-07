import { defineConfig } from "vitest/config"

/**
 * Phase 2.6 / BI-9 carry-over (ADR-0037 + ADR-0038): node-environment
 * test setup for the Yoga / OTel boundary contracts. The full
 * Miniflare integration suite (vitest-pool-workers, `runInDurableObject`,
 * D1 binding) is gated behind `pnpm test:integration` and lives under
 * `test/integration/`; this default suite stays in node so the inner
 * loop is fast.
 */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/integration/**", "node_modules/**"],
    environment: "node",
  },
})
