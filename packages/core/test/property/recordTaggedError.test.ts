import { Effect } from "effect"
import * as fc from "fast-check"
import { describe, expect, it } from "vitest"
import { recordTaggedError } from "../../src/application/runtime/Telemetry.js"
import { errorClassRegistry } from "../../src/domain/errors/Errors.js"

/**
 * Phase 2.6 / BI-9 — `recordTaggedError` registry coverage.
 *
 * The taxonomy of `DomainError` is the `errorClassRegistry` (Phase
 * 2.0 / BI-2). The OTel semconv projection is supposed to be a
 * derivation over the registry — adding a new error class
 * automatically populates `error.type` / `error.code` /
 * `error.severity` on the active span without manual catalogue
 * synchronisation.
 *
 * The properties below pin that contract:
 *
 *   1. **Static metadata coverage** — every registered class
 *      declares the `code` / `severity` statics that
 *      `recordTaggedError` reads. Compile-time-enforced by the
 *      registry's element type, but a runtime check guards against
 *      regressions if the type definition ever loosens.
 *   2. **Code namespace** — every code begins with `E_` and is
 *      uppercase + underscores. Stable codes are an operator
 *      contract (dashboards, runbooks).
 *   3. **Severity stratification** — every entry is exactly one of
 *      the three documented strata.
 *   4. **`recordTaggedError` totality** — invoking the helper for
 *      every class without an active span is a no-op (the helper
 *      pipes through `Effect.ignoreLogged`); none throws or hangs.
 *      This is the safety net for the hot path inside resolvers
 *      that may run before the span context has been seeded
 *      (defensive programming for the `withSpan` boundary).
 */
describe("Phase 2.6 / BI-9 — recordTaggedError registry coverage", () => {
  it("every registered error class declares static `code` + `severity`", () => {
    for (const Klass of errorClassRegistry) {
      expect(typeof Klass.code).toBe("string")
      expect(Klass.code.length).toBeGreaterThan(0)
      expect(["validation", "domain", "infrastructure"]).toContain(Klass.severity)
    }
  })

  it("every code matches the `E_<NAMESPACE>_<NAME>` convention", () => {
    const codePattern = /^E_[A-Z]+_[A-Z0-9_]+$/
    for (const Klass of errorClassRegistry) {
      expect(Klass.code).toMatch(codePattern)
    }
  })

  it("`recordTaggedError` runs without throwing for any registered class", () => {
    fc.assert(
      fc.property(fc.constantFrom(...errorClassRegistry), (Klass) => {
        // Sentinel instance carrying the class's metadata — we only
        // verify the OTel projection helper's shape contract (reads
        // `_tag` + invokes `codeOf` / `severityOf` via `metadataOf`,
        // which trampolines through the constructor). Full instance
        // construction with payload validation is exercised in the
        // unit suite for each error class.
        const sentinel = {
          _tag: Klass.code.replace(/^E_[A-Z]+_/, ""),
          constructor: Klass,
        } as never
        Effect.runSync(recordTaggedError(sentinel))
      }),
      { numRuns: 100 },
    )
  })
})
