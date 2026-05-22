import { describe, expect, it } from "vitest"
import {
  type BoundaryRegistryKey,
  boundaryRegistry,
  deriveBoundaryJsonSchema,
} from "../../../src/server/http/openapiRegistry.js"

/**
 * Boundary single-source contract (ADR-0078). The Effect-Schema
 * declarations in `boundarySchemas.ts` are the canonical
 * description of every HTTP wire shape the router decodes; the
 * registry below exposes them as a single map so future drift gates
 * — and the eventual full `openapi.ts` derive — have one input.
 *
 * Pin checked here:
 *
 *   1. Every registry entry produces a valid JSON Schema document
 *      (no `Schema.toJsonSchemaDocument` panic on schema features
 *      we use).
 *   2. The document carries a `type: "object"` root for every
 *      boundary entry — the router only decodes object bodies /
 *      queries; a regression that produces a non-object schema is
 *      almost certainly a Schema-side typo.
 */

describe("openapiRegistry — boundary Schema → JSON Schema derive", () => {
  const keys = Object.keys(boundaryRegistry) as readonly BoundaryRegistryKey[]

  it.each(keys)("derives a JSON Schema for %s", (key) => {
    const doc = deriveBoundaryJsonSchema(key)
    expect(doc).toBeTypeOf("object")
    // Every boundary surface is an object (Struct); the root schema
    // MUST report `type: "object"`. If a future Schema.Union shows
    // up at the root, this expectation is the place to relax it.
    expect((doc as { schema?: { type?: string } }).schema?.type).toBe("object")
  })

  it("registry covers every boundary export referenced by the router", () => {
    // Trivial existence pin — keep the registry from quietly losing
    // an entry as boundarySchemas.ts evolves. Floor lowered to 12
    // when ADR-0080 removed `ReorderBody`.
    expect(keys.length).toBeGreaterThanOrEqual(12)
  })
})
