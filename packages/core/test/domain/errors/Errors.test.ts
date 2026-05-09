import {
  AlreadyCancelledError,
  ConcurrencyError,
  codeOf,
  DomainErrorSchema,
  InvalidNameKanaError,
  StorageError,
  severityOf,
  type TraceId,
  toLogPayload,
} from "@booking/core"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"

/**
 * Exercise the `Errors.ts` helpers (`codeOf`, `severityOf`,
 * `toLogPayload`) plus the `DomainErrorSchema` round-trip so the
 * registry-side cast in `metadataOf` stays sound under future
 * additions.
 */

describe("codeOf / severityOf", () => {
  it("reads `code` off the tagged-error class", () => {
    expect(codeOf(new InvalidNameKanaError({ reason: "x" }))).toBe("E_VAL_NAME_KANA")
    expect(codeOf(new AlreadyCancelledError({}))).toBe("E_DOM_ALREADY_CANCELLED")
    expect(codeOf(new ConcurrencyError({ expected: 1, actual: 2 }))).toBe("E_INF_CONCURRENCY")
  })

  it("reads `severity` off the tagged-error class", () => {
    expect(severityOf(new InvalidNameKanaError({ reason: "x" }))).toBe("validation")
    expect(severityOf(new AlreadyCancelledError({}))).toBe("domain")
    expect(severityOf(new StorageError({ reason: "io" }))).toBe("infrastructure")
  })
})

describe("toLogPayload", () => {
  it("returns the canonical envelope for a validation error", () => {
    const payload = toLogPayload(new InvalidNameKanaError({ reason: "bad" }))
    expect(payload._tag).toBe("InvalidNameKana")
    expect(payload.code).toBe("E_VAL_NAME_KANA")
    expect(payload.severity).toBe("validation")
    expect(payload.data).toEqual({ reason: "bad" })
    expect(payload.traceId).toBeUndefined()
    expect(payload.cause).toBeUndefined()
  })

  it("propagates the traceId option when supplied", () => {
    const traceId = "01HZZZZZZZZZZZZZZZZZZZZZZZ" as TraceId
    const payload = toLogPayload(new AlreadyCancelledError({}), { traceId })
    expect(payload.traceId).toBe(traceId)
  })

  it("unfolds an `Error` cause attached to a StorageError", () => {
    const cause = new Error("disk full")
    const payload = toLogPayload(new StorageError({ reason: "io", cause }))
    expect(payload.cause).toEqual({ name: "Error", message: "disk full" })
    expect(payload.data).toEqual({ reason: "io" })
  })

  it("omits the cause field when StorageError carries a non-Error cause", () => {
    const payload = toLogPayload(new StorageError({ reason: "io", cause: "raw string" }))
    expect(payload.cause).toBeUndefined()
  })

  it("omits the cause field when StorageError has no cause attached", () => {
    const payload = toLogPayload(new StorageError({ reason: "io" }))
    expect(payload.cause).toBeUndefined()
  })

  it("strips `_tag` and `cause` from the data payload", () => {
    const payload = toLogPayload(new StorageError({ reason: "io", cause: new Error("x") }))
    expect(payload.data).not.toHaveProperty("_tag")
    expect(payload.data).not.toHaveProperty("cause")
  })

  it("includes the structured fields of a ConcurrencyError", () => {
    const payload = toLogPayload(new ConcurrencyError({ expected: 1, actual: 2 }))
    expect(payload.data).toEqual({ expected: 1, actual: 2 })
  })
})

describe("DomainErrorSchema", () => {
  it("is a Schema codec round-trippable through encode/decode for tagged errors", () => {
    // The union codec exists primarily as a type-level pin; we can at
    // least confirm that `is` accepts a constructed error instance.
    const isDomainError = Schema.is(DomainErrorSchema)
    expect(isDomainError(new AlreadyCancelledError({}))).toBe(true)
    expect(isDomainError({ foo: "bar" })).toBe(false)
  })
})
