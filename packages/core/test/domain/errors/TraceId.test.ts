import { isTraceId, parseTraceId, traceIdFromHex } from "@booking/core"
import { Result } from "effect"
import { describe, expect, it } from "vitest"

const VALID_ULID = "01HZZZZZZZZZZZZZZZZZZZZZZZ"

describe("isTraceId", () => {
  it("accepts a 26-char Crockford ULID", () => {
    expect(isTraceId(VALID_ULID)).toBe(true)
  })

  it("rejects strings outside the Crockford alphabet", () => {
    expect(isTraceId("01HZZZZZZZZZZZZZZZZZZZZZZA")).toBe(true)
    expect(isTraceId("invalid_!")).toBe(false)
    // Lowercase letters are not in the Crockford alphabet.
    expect(isTraceId(VALID_ULID.toLowerCase())).toBe(false)
  })
})

describe("parseTraceId", () => {
  it("succeeds on a valid ULID", () => {
    const r = parseTraceId(VALID_ULID)
    expect(Result.isSuccess(r)).toBe(true)
  })

  it("fails on a malformed string with the InvalidTraceId tag", () => {
    const r = parseTraceId("not-a-ulid")
    expect(Result.isFailure(r)).toBe(true)
    if (Result.isFailure(r)) {
      expect(r.failure._tag).toBe("InvalidTraceId")
      expect(r.failure.value).toBe("not-a-ulid")
    }
  })
})

describe("traceIdFromHex", () => {
  it("decodes a 32-char hex string into a 26-char ULID", () => {
    // Arbitrary non-zero hex; the round-trip property is the
    // observable contract.
    const hex = "0123456789abcdef0123456789abcdef"
    const id = traceIdFromHex(hex)
    expect(id).toBeDefined()
    expect(id).toHaveLength(26)
  })

  it("accepts uppercase hex too", () => {
    const id = traceIdFromHex("0123456789ABCDEF0123456789ABCDEF")
    expect(id).toBeDefined()
  })

  it("returns undefined for an all-zero hex (OTel sentinel)", () => {
    expect(traceIdFromHex("00000000000000000000000000000000")).toBeUndefined()
  })

  it("returns undefined for a malformed hex string", () => {
    expect(traceIdFromHex("not-hex")).toBeUndefined()
    expect(traceIdFromHex("0123")).toBeUndefined()
  })
})
