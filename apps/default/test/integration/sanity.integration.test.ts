import { describe, expect, it } from "vitest"
import { inShopDo } from "./_harness/queueShopHarness.js"

/**
 * Sanity check — the integration harness boots, the QueueShop DO
 * stub is reachable, and `runInDurableObject` returns the result
 * the callback yields. Every subsequent integration test depends
 * on this surface; pinning it as its own file makes a harness
 * regression visible immediately.
 */

describe("integration harness boot", () => {
  it("runInDurableObject returns the callback's result", async () => {
    const result = await inShopDo(() => "harness-up")
    expect(result).toBe("harness-up")
  })

  it("the DO has a SqlStorage on state.storage.sql", async () => {
    const sql = await inShopDo((_instance, state) => state.storage.sql)
    expect(sql).toBeDefined()
  })
})
