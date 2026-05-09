import { Temporal } from "@js-temporal/polyfill"
import { Result, Schema } from "effect"
import * as fc from "fast-check"
import { describe, expect, it } from "vitest"
import { schemaToArbitrary } from "../../../src/derive/index.js"
import {
  InstantSchema,
  InstantSelf,
  MINUTES_PER_DAY,
  PlainDateSchema,
  PlainDateSelf,
  PlainTimeSchema,
  PlainTimeSelf,
} from "../../../src/domain/types/Temporal.js"

describe("MINUTES_PER_DAY", () => {
  it("equals 1440", () => {
    expect(MINUTES_PER_DAY).toBe(1440)
  })
})

describe("InstantSchema", () => {
  it("decodes an ISO-8601 string into Temporal.Instant", () => {
    const r = Schema.decodeUnknownResult(InstantSchema)("2026-05-08T09:00:00Z")
    expect(Result.isSuccess(r)).toBe(true)
    if (Result.isSuccess(r)) expect(r.success).toBeInstanceOf(Temporal.Instant)
  })

  it("encodes Temporal.Instant back to its ISO-8601 string", () => {
    const inst = Temporal.Instant.from("2026-05-08T09:00:00Z")
    const r = Schema.encodeUnknownResult(InstantSchema)(inst)
    expect(Result.isSuccess(r)).toBe(true)
    if (Result.isSuccess(r)) expect(typeof r.success).toBe("string")
  })

  it("fails to decode a non-ISO string", () => {
    const r = Schema.decodeUnknownResult(InstantSchema)("not-a-date")
    expect(Result.isFailure(r)).toBe(true)
  })
})

describe("PlainDateSchema", () => {
  it("decodes an ISO date string into Temporal.PlainDate", () => {
    const r = Schema.decodeUnknownResult(PlainDateSchema)("2026-05-08")
    expect(Result.isSuccess(r)).toBe(true)
    if (Result.isSuccess(r)) expect(r.success).toBeInstanceOf(Temporal.PlainDate)
  })

  it("round-trips through encode/decode", () => {
    const date = Temporal.PlainDate.from("2026-05-08")
    const enc = Schema.encodeUnknownResult(PlainDateSchema)(date)
    expect(Result.isSuccess(enc)).toBe(true)
    if (Result.isSuccess(enc)) expect(enc.success).toBe("2026-05-08")
  })

  it("fails to decode a malformed date", () => {
    expect(Result.isFailure(Schema.decodeUnknownResult(PlainDateSchema)("bogus"))).toBe(true)
  })
})

describe("PlainTimeSchema", () => {
  it("decodes an ISO time string into Temporal.PlainTime", () => {
    const r = Schema.decodeUnknownResult(PlainTimeSchema)("09:30:15")
    expect(Result.isSuccess(r)).toBe(true)
    if (Result.isSuccess(r)) expect(r.success).toBeInstanceOf(Temporal.PlainTime)
  })

  it("round-trips through encode/decode", () => {
    const time = Temporal.PlainTime.from("09:30:15")
    const enc = Schema.encodeUnknownResult(PlainTimeSchema)(time)
    expect(Result.isSuccess(enc)).toBe(true)
    if (Result.isSuccess(enc)) expect(enc.success).toContain("09:30:15")
  })

  it("fails to decode a malformed time", () => {
    expect(Result.isFailure(Schema.decodeUnknownResult(PlainTimeSchema)("bogus"))).toBe(true)
  })
})

/**
 * The three `*Self` schemas advertise `toArbitrary` annotations so
 * `Schema.toArbitrary` (and by extension our `schemaToArbitrary`
 * helper) synthesises a fast-check generator without any per-call
 * shimming. Sampling a single value from each generator covers the
 * declaration body and the embedded constructor.
 */
describe("Temporal `toArbitrary` annotations", () => {
  it("InstantSelf produces Temporal.Instant samples", () => {
    const arb = schemaToArbitrary(InstantSelf)
    fc.assert(
      fc.property(arb, (sample) => {
        expect(sample).toBeInstanceOf(Temporal.Instant)
      }),
      { numRuns: 5 },
    )
  })

  it("PlainDateSelf produces Temporal.PlainDate samples in [2000, 2099]", () => {
    const arb = schemaToArbitrary(PlainDateSelf)
    fc.assert(
      fc.property(arb, (sample) => {
        expect(sample).toBeInstanceOf(Temporal.PlainDate)
        expect(sample.year).toBeGreaterThanOrEqual(2000)
        expect(sample.year).toBeLessThanOrEqual(2099)
      }),
      { numRuns: 5 },
    )
  })

  it("PlainTimeSelf produces Temporal.PlainTime samples", () => {
    const arb = schemaToArbitrary(PlainTimeSelf)
    fc.assert(
      fc.property(arb, (sample) => {
        expect(sample).toBeInstanceOf(Temporal.PlainTime)
      }),
      { numRuns: 5 },
    )
  })
})
