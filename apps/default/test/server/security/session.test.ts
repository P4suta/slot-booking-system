import { describe, expect, it } from "vitest"
import {
  readSessionCookie,
  sessionCookieClearHeader,
  sessionCookieHeader,
  signSession,
  verifySession,
} from "../../../src/server/security/session.js"

const SECRET = "test-secret-please-replace-32-bytes-hex-0123456789ab"

describe("staff session cookie round-trip", () => {
  it("signs + verifies a payload", async () => {
    const cookie = await signSession(SECRET, {
      sub: "staff",
      exp: Date.now() + 60_000,
      capabilities: ["operate-queue"],
    })
    const result = await verifySession(SECRET, cookie)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.payload.sub).toBe("staff")
      expect(result.payload.capabilities).toEqual(["operate-queue"])
    }
  })

  it("rejects a cookie signed with a different secret", async () => {
    const cookie = await signSession(SECRET, {
      sub: "staff",
      exp: Date.now() + 60_000,
      capabilities: ["operate-queue"],
    })
    const result = await verifySession(`${SECRET}-different`, cookie)
    expect(result.ok).toBe(false)
  })

  it("rejects an expired cookie", async () => {
    const cookie = await signSession(SECRET, {
      sub: "staff",
      exp: Date.now() - 1,
      capabilities: ["operate-queue"],
    })
    const result = await verifySession(SECRET, cookie)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("expired")
  })

  it("rejects a tampered payload (signature no longer matches)", async () => {
    const cookie = await signSession(SECRET, {
      sub: "staff",
      exp: Date.now() + 60_000,
      capabilities: ["operate-queue"],
    })
    // Flip a payload byte; the signature stays the same but no
    // longer matches the recomputed MAC over the modified body.
    const dot = cookie.lastIndexOf(".")
    const tampered = `${cookie.slice(0, 1) === "Z" ? "Y" : "Z"}${cookie.slice(1, dot)}.${cookie.slice(dot + 1)}`
    const result = await verifySession(SECRET, tampered)
    expect(result.ok).toBe(false)
  })

  it("rejects a malformed cookie shape", async () => {
    const result = await verifySession(SECRET, "no-dot")
    expect(result.ok).toBe(false)
  })
})

describe("session cookie header builders", () => {
  it("emits the __Host- prefix + HttpOnly + Secure + SameSite + Path", () => {
    const header = sessionCookieHeader("token", 60)
    expect(header.startsWith("__Host-staff_session=token")).toBe(true)
    expect(header).toContain("HttpOnly")
    expect(header).toContain("Secure")
    expect(header).toContain("SameSite=Strict")
    expect(header).toContain("Path=/")
    expect(header).toContain("Max-Age=60")
  })

  it("clear builder zeros the value + Max-Age=0", () => {
    const header = sessionCookieClearHeader()
    expect(header.startsWith("__Host-staff_session=")).toBe(true)
    expect(header).toContain("Max-Age=0")
  })
})

describe("readSessionCookie", () => {
  it("extracts the value when present", () => {
    expect(readSessionCookie("__Host-staff_session=abc123; other=x")).toBe("abc123")
  })

  it("returns null when the cookie is absent", () => {
    expect(readSessionCookie("other=x")).toBeNull()
    expect(readSessionCookie(undefined)).toBeNull()
  })

  it("returns null for an empty value", () => {
    expect(readSessionCookie("__Host-staff_session=")).toBeNull()
  })
})
