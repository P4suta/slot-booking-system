import { Schema } from "effect"
import * as fc from "fast-check"
import { describe, expect, it } from "vitest"
import { schemaToArbitrary, schemaToCheckConstraint } from "../../src/derive/index.js"
import { PhoneLast4Schema } from "../../src/domain/value-objects/PhoneLast4.js"

describe("schemaToArbitrary", () => {
  it("derives a fast-check Arbitrary that produces values matching the schema's decoder", () => {
    const arb = schemaToArbitrary(PhoneLast4Schema)
    fc.assert(
      fc.property(arb, (value) => {
        // PhoneLast4 is a 4-digit string; the schema's pattern enforces /^\d{4}$/.
        expect(typeof value).toBe("string")
        expect(value).toMatch(/^\d{4}$/)
      }),
      { numRuns: 100 },
    )
  })
})

describe("schemaToCheckConstraint", () => {
  it("renders a SQLite REGEXP CHECK clause for a pattern-bearing schema", () => {
    const clause = schemaToCheckConstraint(PhoneLast4Schema, "phone_last4")
    expect(clause).not.toBeNull()
    expect(clause).toContain("phone_last4")
    expect(clause).toContain("REGEXP")
    expect(clause).toContain("\\d")
  })

  it("returns null for a schema without a regex pattern annotation", () => {
    const plainNumber = Schema.Number
    expect(schemaToCheckConstraint(plainNumber, "n")).toBeNull()
  })
})
