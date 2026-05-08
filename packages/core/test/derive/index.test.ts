import * as fc from "fast-check"
import { describe, expect, it } from "vitest"
import { schemaToArbitrary } from "../../src/derive/index.js"
import { PhoneLast4Schema } from "../../src/domain/value-objects/PhoneLast4.js"

describe("schemaToArbitrary", () => {
  it("derives a fast-check Arbitrary that produces values matching the schema's decoder", () => {
    const arb = schemaToArbitrary(PhoneLast4Schema)
    fc.assert(
      fc.property(arb, (value) => {
        expect(typeof value).toBe("string")
        expect(value).toMatch(/^\d{4}$/)
      }),
      { numRuns: 100 },
    )
  })
})
