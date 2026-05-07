import { Result, Schema } from "effect"
import * as fc from "fast-check"
import { describe, expect, it } from "vitest"
import { HoldSlotRequestSchema } from "../../../src/application/schemas/HoldSlotRequest.js"

const decode = Schema.decodeUnknownResult(HoldSlotRequestSchema)
const encode = Schema.encodeSync(HoldSlotRequestSchema)

describe("HoldSlotRequestSchema", () => {
  it("decodes a fully-populated wire payload", () => {
    const payload = {
      serviceId: "serv_01h8xrqmkqdnfgxt7nh3avh3xs",
      date: "2026-05-05",
      startMinute: 540,
      nameKana: "ヤマダ タロウ",
      phoneLast4: "1234",
      freeText: "first visit",
    }
    const r = decode(payload)
    expect(Result.isSuccess(r)).toBe(true)
  })

  it("decodes a payload without the optional freeText", () => {
    const payload = {
      serviceId: "serv_01h8xrqmkqdnfgxt7nh3avh3xs",
      date: "2026-05-05",
      startMinute: 0,
      nameKana: "ヤマダ",
      phoneLast4: "9999",
    }
    expect(Result.isSuccess(decode(payload))).toBe(true)
  })

  it.each([
    ["malformed serviceId prefix", { serviceId: "prov_01h8xrqmkqdnfgxt7nh3avh3xs" }],
    ["bad date", { date: "not-a-date" }],
    ["startMinute below range", { startMinute: -1 }],
    ["startMinute above range", { startMinute: 1440 }],
    ["non-integer startMinute", { startMinute: 1.5 }],
    ["bad phoneLast4", { phoneLast4: "12a4" }],
    ["empty nameKana", { nameKana: "" }],
  ])("rejects: %s", (_label, override) => {
    const payload = {
      serviceId: "serv_01h8xrqmkqdnfgxt7nh3avh3xs",
      date: "2026-05-05",
      startMinute: 540,
      nameKana: "ヤマダ タロウ",
      phoneLast4: "1234",
      ...override,
    }
    expect(Result.isFailure(decode(payload))).toBe(true)
  })

  it("property: decode ∘ encode is identity for any valid request", () => {
    const validPayloadArb = fc.record({
      serviceId: fc.constant("serv_01h8xrqmkqdnfgxt7nh3avh3xs"),
      date: fc.constant("2026-05-05"),
      startMinute: fc.integer({ min: 0, max: 1439 }),
      nameKana: fc.constantFrom("ヤマダ", "サトウ", "イチカワ"),
      phoneLast4: fc.stringMatching(/^\d{4}$/),
    })
    fc.assert(
      fc.property(validPayloadArb, (p) => {
        const decoded = decode(p)
        if (Result.isFailure(decoded)) return false
        const encoded = encode(decoded.success)
        return (
          encoded.serviceId === p.serviceId &&
          encoded.date === p.date &&
          encoded.startMinute === p.startMinute &&
          encoded.nameKana === p.nameKana &&
          encoded.phoneLast4 === p.phoneLast4
        )
      }),
      { numRuns: 200 },
    )
  })
})
