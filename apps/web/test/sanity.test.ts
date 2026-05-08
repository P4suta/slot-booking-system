import { describe, expect, it } from "vitest"

describe("apps/web sanity", () => {
  it("runs vitest under the apps/web config", () => {
    expect(1 + 1).toBe(2)
  })
})
