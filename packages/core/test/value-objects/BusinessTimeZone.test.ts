import { Result } from "effect"
import { describe, expect, it } from "vitest"
import { parseBusinessTimeZone } from "../../src/domain/value-objects/BusinessTimeZone.js"

describe("BusinessTimeZone", () => {
  it.each(["UTC", "Asia/Tokyo", "America/Los_Angeles", "Europe/Berlin"])("accepts %s", (tz) => {
    expect(Result.isSuccess(parseBusinessTimeZone(tz))).toBe(true)
  })

  it.each(["Invalid/Time_Zone", "Asia/Atlantis", "", "not-a-zone"])("rejects %p", (tz) => {
    expect(Result.isFailure(parseBusinessTimeZone(tz))).toBe(true)
  })
})
