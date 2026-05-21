import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    reporters: ["verbose", "../../scripts/test/streamReporter.ts"],
    environment: "node",
  },
})
