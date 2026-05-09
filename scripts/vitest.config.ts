import { defineConfig } from "vitest/config"

/**
 * Tooling-side vitest project for the TypeScript scripts that
 * replace the legacy shell wrappers (`scripts/test-runner.sh`,
 * `scripts/check-parallel.sh`, `scripts/diagnose*.sh`, …).
 *
 * Unit tests cover the *pure* parts (exit-code classifier, stream
 * event parser) so the orchestration code can spawn child
 * processes confidently — pure branches are pinned in vitest, the
 * impure spawn surfaces are exercised by `just test` itself.
 */
export default defineConfig({
  test: {
    include: ["**/*.test.ts"],
    reporters: ["verbose", "./test/streamReporter.ts"],
    environment: "node",
  },
})
