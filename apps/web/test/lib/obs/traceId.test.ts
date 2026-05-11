import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { generateTraceId, TRACE_ID_RE } from "../../../src/lib/obs/traceId.js"

/**
 * Stage 20 / ADR-0088 client-side trace id contract.
 *
 * Three classes of invariant:
 *   - alphabet + length: 26 lowercase Crockford chars (no i/l/o/u)
 *   - timestamp prefix: monotone for ids generated in increasing ms
 *   - uniqueness: 80 bits of entropy keep collisions vanishing at
 *     batch sizes the customer-facing page emits
 */

describe("generateTraceId — alphabet + length", () => {
  it("produces a 26-character string", () => {
    expect(generateTraceId()).toHaveLength(26)
  })

  it("matches the Crockford lowercase regex", () => {
    for (let i = 0; i < 64; i += 1) {
      const id = generateTraceId()
      expect(id).toMatch(TRACE_ID_RE)
    }
  })

  it("never contains i / l / o / u", () => {
    for (let i = 0; i < 64; i += 1) {
      const id = generateTraceId()
      expect(id).not.toMatch(/[ilou]/)
    }
  })
})

describe("generateTraceId — monotone timestamp prefix", () => {
  let originalNow: () => number

  beforeEach(() => {
    originalNow = Date.now
  })

  afterEach(() => {
    Date.now = originalNow
  })

  it("ids generated at increasing ms sort lexicographically", () => {
    let ms = 1_715_000_000_000 // 2024-05 epoch — well-formed 48-bit value
    Date.now = () => ms
    const a = generateTraceId()
    ms += 1
    const b = generateTraceId()
    ms += 1000
    const c = generateTraceId()
    // Lexicographic ordering on the 10-char prefix
    expect(a.slice(0, 10) <= b.slice(0, 10)).toBe(true)
    expect(b.slice(0, 10) < c.slice(0, 10)).toBe(true)
  })

  it("encodes the same timestamp identically across calls", () => {
    Date.now = () => 1_715_000_000_000
    const prefixA = generateTraceId().slice(0, 10)
    const prefixB = generateTraceId().slice(0, 10)
    expect(prefixA).toBe(prefixB)
  })
})

describe("generateTraceId — uniqueness", () => {
  it("emits unique values across a batch of 1024", () => {
    const seen = new Set<string>()
    for (let i = 0; i < 1024; i += 1) seen.add(generateTraceId())
    expect(seen.size).toBe(1024)
  })
})

describe("generateTraceId — crypto fallback", () => {
  it("throws when getRandomValues is unavailable", () => {
    const original = globalThis.crypto
    Object.defineProperty(globalThis, "crypto", {
      value: undefined,
      configurable: true,
    })
    try {
      expect(() => generateTraceId()).toThrow(/crypto.getRandomValues/)
    } finally {
      Object.defineProperty(globalThis, "crypto", {
        value: original,
        configurable: true,
      })
    }
  })
})
