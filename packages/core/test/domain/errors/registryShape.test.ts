import { errorClassRegistry } from "@booking/core"
import { describe, expect, it } from "vitest"

/**
 * Pin the static structural invariants of `errorClassRegistry` so a
 * future commit cannot widen / narrow the registry without updating
 * the matching `docs/error-codes.md` (drift-gated by
 * `just error-docs-drift-check`) and the prefix-grouping convention
 * the docs and ADR-0017 both rely on.
 *
 * Queue-pivot layout: 6 validation entries → 8 domain entries → 3
 * infrastructure. The validity of `errorToGraphQLPayload` and the
 * i18n-key generator both rest on this contiguous severity ordering.
 */
describe("errorClassRegistry", () => {
  it("has 17 entries", () => {
    expect(errorClassRegistry).toHaveLength(17)
  })

  const severitiesOf = (): readonly string[] =>
    errorClassRegistry.map(
      (cls) => (cls as { readonly severity: "validation" | "domain" | "infrastructure" }).severity,
    )

  it("groups severities in 6/8/3 contiguous blocks", () => {
    const seen = severitiesOf()
    expect(seen.slice(0, 6).every((s) => s === "validation")).toBe(true)
    expect(seen.slice(6, 14).every((s) => s === "domain")).toBe(true)
    expect(seen.slice(14, 17).every((s) => s === "infrastructure")).toBe(true)
  })

  it("uses unique error codes", () => {
    const codes = errorClassRegistry.map((cls) => (cls as { readonly code: string }).code)
    expect(new Set(codes).size).toBe(codes.length)
  })

  it("uses unique class names", () => {
    const names = errorClassRegistry.map(
      (cls) => (cls as unknown as { readonly name: string }).name,
    )
    expect(new Set(names).size).toBe(names.length)
  })
})
