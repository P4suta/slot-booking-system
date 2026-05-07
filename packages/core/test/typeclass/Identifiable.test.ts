import { Order } from "effect"
import * as fc from "fast-check"
import { describe, expect, it } from "vitest"
import * as Identifiable from "../../src/domain/typeclass/Identifiable.js"

type Tagged = { readonly id: string; readonly payload: number }

const tagged: Identifiable.Identifiable<Tagged> = Identifiable.make((t) => t.id)

const arbTagged: fc.Arbitrary<Tagged> = fc.record({
  id: fc.string({ minLength: 1, maxLength: 16 }),
  payload: fc.integer(),
})

describe("Identifiable", () => {
  it("idOf returns the id projection", () => {
    const t: Tagged = { id: "x_1", payload: 42 }
    expect(tagged.idOf(t)).toBe("x_1")
  })

  describe("toEquivalence", () => {
    const eq = Identifiable.toEquivalence(tagged)

    it("reflexive (property)", () => {
      fc.assert(fc.property(arbTagged, (a) => eq(a, a)))
    })

    it("symmetric (property)", () => {
      fc.assert(fc.property(arbTagged, arbTagged, (a, b) => eq(a, b) === eq(b, a)))
    })

    it("transitive when ids agree (property)", () => {
      fc.assert(
        fc.property(fc.string({ minLength: 1 }), fc.integer(), fc.integer(), (id, p, q) => {
          const a: Tagged = { id, payload: p }
          const b: Tagged = { id, payload: q }
          const c: Tagged = { id, payload: p + q }
          return eq(a, b) && eq(b, c) && eq(a, c)
        }),
      )
    })

    it("ignores non-id fields", () => {
      const a: Tagged = { id: "x_1", payload: 1 }
      const b: Tagged = { id: "x_1", payload: 999 }
      expect(eq(a, b)).toBe(true)
    })
  })

  describe("toOrder", () => {
    const order = Identifiable.toOrder(tagged)

    it("agrees with Order.String composed with idOf (property)", () => {
      fc.assert(
        fc.property(arbTagged, arbTagged, (a, b) => order(a, b) === Order.String(a.id, b.id)),
      )
    })

    it("antisymmetry: order(a,b) === -order(b,a) (property)", () => {
      fc.assert(fc.property(arbTagged, arbTagged, (a, b) => order(a, b) === -order(b, a)))
    })

    it("transitivity (property)", () => {
      fc.assert(
        fc.property(arbTagged, arbTagged, arbTagged, (a, b, c) => {
          if (order(a, b) <= 0 && order(b, c) <= 0) return order(a, c) <= 0
          return true
        }),
      )
    })
  })
})
