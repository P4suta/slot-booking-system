import { errorClassRegistry } from "@booking/core"
import { describe, expect, it } from "vitest"

/**
 * Pin the static structural invariants of `errorClassRegistry` so a
 * future commit cannot widen / narrow the registry without updating
 * the matching `docs/error-codes.md` (drift-gated by
 * `just error-docs-drift-check`) and the prefix-grouping convention
 * the docs and ADR-0017 both rely on.
 *
 * Layout: 17 validation entries → 13 domain entries → 3 infrastructure.
 * The validity of `errorToGraphQLPayload` and the i18n-key generator
 * both rest on this contiguous severity ordering.
 */
describe("errorClassRegistry", () => {
  it("has 33 entries", () => {
    expect(errorClassRegistry).toHaveLength(33)
  })

  const severitiesOf = (): readonly string[] =>
    errorClassRegistry.map(
      (cls) => (cls as { readonly severity: "validation" | "domain" | "infrastructure" }).severity,
    )

  it("groups severities in 17/13/3 contiguous blocks", () => {
    const seen = severitiesOf()
    expect(seen.slice(0, 17).every((s) => s === "validation")).toBe(true)
    expect(seen.slice(17, 30).every((s) => s === "domain")).toBe(true)
    expect(seen.slice(30, 33).every((s) => s === "infrastructure")).toBe(true)
  })

  it("uses unique error codes", () => {
    const codes = errorClassRegistry.map((cls) => (cls as { readonly code: string }).code)
    expect(new Set(codes).size).toBe(codes.length)
  })

  it("uses unique class names", () => {
    const names = errorClassRegistry.map((cls) => (cls as { readonly name: string }).name)
    expect(new Set(names).size).toBe(names.length)
  })
})
