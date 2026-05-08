import { describe, expect, it } from "vitest"

describe("sanity", () => {
  it("vitest runs inside the dev container", () => {
    expect(1 + 1).toBe(2)
  })
})
