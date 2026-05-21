import { describe, expect, it } from "vitest"
import {
  base64UrlToBytes,
  bytesToBase64Url,
  bytesToString,
  stringToBytes,
} from "../src/base64url.js"

describe("base64url", () => {
  it("round-trips a short byte buffer", () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 254, 255])
    const encoded = bytesToBase64Url(bytes)
    expect(encoded).not.toMatch(/[+/=]/)
    const decoded = base64UrlToBytes(encoded)
    expect(Array.from(decoded)).toEqual(Array.from(bytes))
  })

  it("uses '-' and '_' in place of '+' and '/'", () => {
    // 0xff 0xff 0xff in base64 is "////"; in base64url it's "____".
    expect(bytesToBase64Url(new Uint8Array([0xff, 0xff, 0xff]))).toBe("____")
    // 0xfb 0xff in base64 is "+/8="; in base64url it's "-_8".
    expect(bytesToBase64Url(new Uint8Array([0xfb, 0xff]))).toBe("-_8")
  })

  it("decodes without explicit padding", () => {
    // "test" → 0x74 0x65 0x73 0x74
    expect(Array.from(base64UrlToBytes("dGVzdA"))).toEqual([0x74, 0x65, 0x73, 0x74])
  })

  it("string round-trip via UTF-8", () => {
    const s = "ヤマダ タロウ"
    const bytes = stringToBytes(s)
    expect(bytesToString(bytes)).toBe(s)
    const encoded = bytesToBase64Url(bytes)
    expect(bytesToString(base64UrlToBytes(encoded))).toBe(s)
  })
})
