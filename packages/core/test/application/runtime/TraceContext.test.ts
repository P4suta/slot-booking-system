import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { getCurrentTraceId } from "../../../src/application/runtime/TraceContext.js"
import { isTraceId, traceIdFromHex } from "../../../src/domain/errors/TraceId.js"

describe("getCurrentTraceId", () => {
  it("returns undefined when no span has wrapped the effect", async () => {
    const value = await Effect.runPromise(getCurrentTraceId)
    expect(value).toBeUndefined()
  })

  it("returns a TraceId-shaped value when a span is active", async () => {
    const program = getCurrentTraceId.pipe(Effect.withSpan("test-span"))
    const value = await Effect.runPromise(program)
    expect(value).toBeDefined()
    expect(isTraceId(value as string)).toBe(true)
  })
})

describe("traceIdFromHex", () => {
  it("encodes 32 hex chars to a 26-char Crockford ULID", () => {
    const out = traceIdFromHex("0123456789abcdef0123456789abcdef")
    expect(out).toBeDefined()
    expect(out).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(isTraceId(out as string)).toBe(true)
  })

  it("returns undefined for the all-zero traceId (no-op span sentinel)", () => {
    expect(traceIdFromHex("00000000000000000000000000000000")).toBeUndefined()
  })

  it("returns undefined for a non-hex input", () => {
    expect(traceIdFromHex("not-a-hex-string-of-the-right-len")).toBeUndefined()
  })

  it("returns undefined for a hex string of wrong length", () => {
    expect(traceIdFromHex("0123456789abcdef")).toBeUndefined()
    expect(traceIdFromHex("0123456789abcdef0123456789abcdef00")).toBeUndefined()
  })

  it("encodes deterministically (same hex → same ULID)", () => {
    const hex = "deadbeefdeadbeefdeadbeefdeadbeef"
    expect(traceIdFromHex(hex)).toBe(traceIdFromHex(hex))
  })

  it("preserves bit-exact mapping (max 128-bit value lands on a valid ULID)", () => {
    const out = traceIdFromHex("ffffffffffffffffffffffffffffffff")
    expect(out).toBeDefined()
    expect(isTraceId(out as string)).toBe(true)
    // 2^128 fits in 26 Crockford chars; top char encodes the leading
    // 3 bits (max value "7") so we never overflow into "8" or "9".
    expect(out?.charAt(0)).toBe("7")
  })
})
