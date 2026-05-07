import * as fc from "fast-check"
import { describe, expect, it } from "vitest"
import { asView, type BookingView } from "../../../src/domain/read/BookingView.js"
import * as IxState from "../../../src/domain/read/IxState.js"
import { baseHeld } from "../../_fixtures/index.js"

/*
 * Atkey indexed state monad law suite. Uses a concrete `ViewT<"Held">`
 * fixture as the starting state; the law assertions thread an integer
 * value through the IxState whose state index is fixed at "Held"
 * (so flatMap composition is well-typed at the top level).
 */

const seedView = (): IxState.ViewT<"Held"> =>
  IxState.indexView<"Held">(asView(baseHeld()) as BookingView & { readonly state: "Held" })

const arbValue = fc.integer()

describe("IxState — Atkey indexed state monad", () => {
  it("left identity: flatMap(pure(a), f) ≡ f(a) (property)", () => {
    fc.assert(
      fc.property(arbValue, (a) => {
        const f = (x: number): IxState.IxState<"Held", "Held", string> =>
          IxState.pure(`v=${String(x)}`)
        const lhs = IxState.flatMap(IxState.pure<"Held", number>(a), f)
        const rhs = f(a)
        const view = seedView()
        return JSON.stringify(IxState.run(lhs, view)) === JSON.stringify(IxState.run(rhs, view))
      }),
    )
  })

  it("right identity: flatMap(m, pure) ≡ m (property)", () => {
    fc.assert(
      fc.property(arbValue, (a) => {
        const m = IxState.pure<"Held", number>(a)
        const lhs = IxState.flatMap(m, (x) => IxState.pure<"Held", number>(x))
        const view = seedView()
        return JSON.stringify(IxState.run(lhs, view)) === JSON.stringify(IxState.run(m, view))
      }),
    )
  })

  it("associativity: flatMap(flatMap(m, f), g) ≡ flatMap(m, x => flatMap(f(x), g)) (property)", () => {
    fc.assert(
      fc.property(arbValue, arbValue, arbValue, (a, b, c) => {
        const m = IxState.pure<"Held", number>(a)
        const f = (x: number): IxState.IxState<"Held", "Held", number> => IxState.pure(x + b)
        const g = (x: number): IxState.IxState<"Held", "Held", number> => IxState.pure(x * c)
        const lhs = IxState.flatMap(IxState.flatMap(m, f), g)
        const rhs = IxState.flatMap(m, (x) => IxState.flatMap(f(x), g))
        const view = seedView()
        return JSON.stringify(IxState.run(lhs, view)) === JSON.stringify(IxState.run(rhs, view))
      }),
    )
  })

  it("pure carries the value and leaves the state unchanged", () => {
    const m = IxState.pure<"Held", string>("hello")
    const view = seedView()
    const [a, out] = IxState.run(m, view)
    expect(a).toBe("hello")
    expect(out).toBe(view)
  })

  it("runReplay over an empty event list returns the seed view", () => {
    const seed = baseHeld()
    const view = IxState.runReplay(seed, [])
    expect(view.state).toBe("Held")
    expect(view.id).toBe(seed.id)
  })
})
