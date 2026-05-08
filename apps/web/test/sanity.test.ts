import { describe, expect, it } from "vitest"

/**
 * Smoke-level fixture so `pnpm -r run test` is a real gate. Commit 13
 * extends this directory with SvelteKit SSR / paraglide / gql.tada
 * drift assertions; until then this file establishes the baseline so
 * the lefthook pre-push and the CI pipeline both exercise the
 * apps/web vitest config and never silently skip the package.
 */
describe("apps/web sanity", () => {
  it("runs vitest under the apps/web config", () => {
    expect(1 + 1).toBe(2)
  })
})
