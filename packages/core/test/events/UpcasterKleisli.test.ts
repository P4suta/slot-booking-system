import { describe, expect, it } from "vitest"
import {
  composeUpcaster,
  identityUpcaster,
  type Upcaster,
  upcastChain,
  type VersionedCodec,
} from "../../src/domain/events/Upcaster.js"

describe("Upcaster Kleisli composition (ADR-0032 extension)", () => {
  it("identityUpcaster is a no-op", () => {
    const id = identityUpcaster<number>()
    expect(id(7)).toBe(7)
  })

  it("composeUpcaster threads f then g (left-to-right)", () => {
    const f: Upcaster<number, string> = (n) => `n=${String(n)}`
    const g: Upcaster<string, number> = (s) => s.length
    const composed = composeUpcaster(f, g)
    expect(composed(123)).toBe(5) // "n=123" length
  })

  it("upcastChain folds an empty chain into identity", () => {
    const fold = upcastChain([])
    expect(fold("anything")).toBe("anything")
  })

  it("upcastChain folds a non-empty chain in order", () => {
    const a: Upcaster<unknown, unknown> = (x) => `${String(x)}-a`
    const b: Upcaster<unknown, unknown> = (x) => `${String(x)}-b`
    const c: Upcaster<unknown, unknown> = (x) => `${String(x)}-c`
    expect(upcastChain([a, b, c])("seed")).toBe("seed-a-b-c")
  })

  it("VersionedCodec is structurally usable for v-pinned schemas", () => {
    const v1: VersionedCodec<1, { kind: "v1" }> = {
      version: 1,
      schema: undefined as never, // structural test only — no runtime decode here
    }
    expect(v1.version).toBe(1)
  })
})
