import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // See `packages/core/vitest.config.ts` for the rationale —
    // `streamReporter` emits CASE_START events for the wrapper's
    // heartbeat consumer.
    reporters: ["verbose", "../../scripts/test/streamReporter.ts"],
    environment: "node",
  },
})
