import { defineConfig } from "vitest/config"

/**
 * Phase 3 PR#8 — minimal vitest config for `apps/web` so
 * `pnpm -r run test` is a real gate. The `echo 'no tests'` placeholder
 * the package previously carried gave a green-by-default exit code,
 * which masked the absence of any web-side test coverage. Commit 13
 * (in the same PR) extends this with SvelteKit SSR / paraglide /
 * gql.tada drift fixtures.
 */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
})
