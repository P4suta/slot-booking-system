import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

/**
 * Resolve `@booking/core` to the in-tree `src/` entry rather than the
 * compiled `dist/` re-export. The package's `exports` map points at
 * `dist/index.js` for downstream consumers (apps/default, apps/web),
 * but tests in this very package would otherwise import their own
 * compiled artefacts — which V8 coverage instrumentation does not
 * trace, leaving every test that uses the public surface (`RuntimeMode`,
 * `LogSampler`, …) with 0 % coverage on the `src/` files. The alias
 * forces the same module identity as the test files imported via
 * relative paths, so coverage is single-source-of-truth.
 */
const SRC_INDEX = fileURLToPath(new URL("./src/index.ts", import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      "@booking/core": SRC_INDEX,
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    benchmark: {
      include: ["test/**/*.bench.ts"],
      reporters: ["default"],
    },
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/index.ts",
        "src/**/*.d.ts",
        // Type-only files — declarations / discriminated-union types only.
        "src/domain/booking/Command.ts",
        // Effect 4 `Context.Service<T, S>()(name)` factory pattern.
        // V8 source-map coverage cannot instrument the dynamic class
        // extension; every `application/ports/*.ts` reads as 0 % despite
        // being loaded transitively by every adapter / use-case test.
        // The behavioural contract of each port is asserted at the
        // adapter layer (`SystemClockLive.test.ts`, `RuntimeMode.test.ts`,
        // `LogSampler.test.ts`, …). Re-included once Effect graduates
        // from the beta line and the upstream tracer fix lands; ADR-0042
        // notes the carry-over.
        "src/application/ports/**/*.ts",
      ],
      // C1 100 % is the standing target (Day-1 user discipline). The
      // current baseline (Phase 3 PR#8) sits at 98.6 lines / 98.8 funcs
      // / 87 branches because of pre-PR#8 gaps in `domain/slot/bipartite.ts`,
      // `domain/slot/computeAvailableSlots.ts:275-283`, `derive/openapi.ts`
      // generator branches, and a few smaller numeric edge cases. The
      // threshold tracks the achieved baseline so a regression below it
      // fires; the path back to 100 is Phase 3.x scope (each file gets
      // a dedicated property-based test suite covering the saturating /
      // unreachable branches the current units skip).
      thresholds: {
        branches: 86,
        functions: 98,
        lines: 98,
        statements: 97,
      },
    },
  },
})
