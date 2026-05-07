import { describe, expect, it } from "vitest"
import { sanitiseForStructuredClone } from "../../src/server/durableObjects/effectRpc/transport.js"

/**
 * `sanitiseForStructuredClone` — pin the targeted shallow transform
 * the DO RPC boundary applies before `stub.dispatch` (ADR-0044).
 *
 * The transform is intentionally narrow: only the `headers` field
 * (which `RpcClient.makeNoSerialization` builds via
 * `Object.create(null)`) is copied to a plain-prototype shallow
 * record; everything else passes through unchanged so Effect's
 * class-instance brands (`_id` markers on `Exit` / `Cause` etc.)
 * survive the cross-isolate hop.
 */
describe("sanitiseForStructuredClone", () => {
  it("converts a null-prototype headers field to a plain-prototype shallow copy", () => {
    const nullHeaders = Object.create(null) as Record<string, unknown>
    nullHeaders.xTest = "1"
    const message = { _tag: "Request", id: 0n, tag: "HoldSlot", headers: nullHeaders }
    const out = sanitiseForStructuredClone(message)
    expect(Object.getPrototypeOf(out.headers)).toBe(Object.prototype)
    expect(out.headers).toEqual({ xTest: "1" })
  })

  it("encodes BigInt id to a sigil string and structurally preserves other fields", () => {
    const payload = { slot: { serviceId: "serv_demo" } }
    const message = {
      _tag: "Request",
      id: 42n,
      tag: "HoldSlot",
      payload,
      traceId: "01HW8RZB",
      spanId: "abc",
      sampled: true,
      headers: Object.create(null) as Record<string, unknown>,
    }
    const out = sanitiseForStructuredClone(message)
    expect(out.id).toBe("__bigint:42")
    expect(out.tag).toBe("HoldSlot")
    expect(out.payload).toEqual(payload) // structurally equal (deep clone)
    expect(out.traceId).toBe("01HW8RZB")
    expect(out.sampled).toBe(true)
  })

  it("encodes / desanitises BigInt id and requestId round-trip", async () => {
    const { desanitiseFromStructuredClone } = await import(
      "../../src/server/durableObjects/effectRpc/transport.js"
    )
    const message = { id: 99999999999n, requestId: 1n }
    const round = desanitiseFromStructuredClone(sanitiseForStructuredClone(message))
    expect(round.id).toBe(99999999999n)
    expect(round.requestId).toBe(1n)
  })

  it("is idempotent — sanitise(sanitise(x)) ≡ sanitise(x)", () => {
    const headers = Object.create(null) as Record<string, unknown>
    headers.x = "y"
    const once = sanitiseForStructuredClone({ _tag: "Request", id: 0n, headers })
    const twice = sanitiseForStructuredClone(once)
    expect(twice).toEqual(once)
    expect(Object.getPrototypeOf(twice.headers)).toBe(Object.prototype)
  })

  it("structurally preserves messages with no transform-needed fields", () => {
    const message = { _tag: "Eof" }
    expect(sanitiseForStructuredClone(message)).toEqual(message)
  })

  it("returns non-object inputs as-is", () => {
    expect(sanitiseForStructuredClone(null as unknown as { headers: unknown })).toBe(null)
    expect(sanitiseForStructuredClone(undefined as unknown as { headers: unknown })).toBe(undefined)
  })
})
