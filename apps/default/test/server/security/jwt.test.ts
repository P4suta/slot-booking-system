import { describe, expect, it } from "vitest"
import { signStaffJwt, verifyStaffJwt } from "../../../src/server/security/jwt.js"

const SECRET = "test-secret-please-replace-32-bytes-hex-0123456789ab"

describe("staff JWT round-trip", () => {
  it("signs + verifies a token with the default capability", async () => {
    const jwt = await signStaffJwt(SECRET, 60)
    const result = await verifyStaffJwt(SECRET, jwt)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.payload.sub).toBe("staff")
      expect(result.payload.capabilities).toContain("operate-queue")
      expect(result.payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000))
    }
  })

  it("rejects a token signed with a different secret", async () => {
    const jwt = await signStaffJwt(SECRET, 60)
    const result = await verifyStaffJwt(`${SECRET}-different`, jwt)
    expect(result.ok).toBe(false)
  })

  it("rejects an expired token", async () => {
    const jwt = await signStaffJwt(SECRET, -1)
    const result = await verifyStaffJwt(SECRET, jwt)
    expect(result.ok).toBe(false)
  })

  it("rejects a structurally malformed token", async () => {
    const result = await verifyStaffJwt(SECRET, "not.a.jwt")
    expect(result.ok).toBe(false)
  })

  it("supports custom capability sets", async () => {
    const jwt = await signStaffJwt(SECRET, 60, ["operate-queue", "view-pii"])
    const result = await verifyStaffJwt(SECRET, jwt)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.payload.capabilities).toEqual(["operate-queue", "view-pii"])
    }
  })
})
