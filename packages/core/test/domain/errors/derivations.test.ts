import {
  AlreadyCancelledError,
  ConcurrencyError,
  errorToAuditEntry,
  errorToGraphQLExtensions,
  errorToGraphQLPayload,
  errorToI18nKey,
  InvalidNameKanaError,
  StorageError,
  type TraceId,
} from "@booking/core"
import { describe, expect, it } from "vitest"

/**
 * Pin the four error-derivation surfaces (i18n key, GraphQL payload,
 * GraphQL extensions, audit entry) so a refactor that decouples one
 * representation from another fails loudly. The errors below cover all
 * three severity bands so the `severity` field on the GraphQL payload
 * is exercised on every arm.
 */

describe("errorToI18nKey", () => {
  it("returns `error.<_tag>` verbatim", () => {
    expect(errorToI18nKey(new InvalidNameKanaError({ reason: "x" }))).toBe("error.InvalidNameKana")
    expect(errorToI18nKey(new AlreadyCancelledError({}))).toBe("error.AlreadyCancelled")
    expect(errorToI18nKey(new ConcurrencyError({ expected: 1, actual: 2 }))).toBe(
      "error.Concurrency",
    )
  })
})

describe("errorToGraphQLPayload", () => {
  it("renders the typed union arm with code / severity / i18nKey", () => {
    const payload = errorToGraphQLPayload(new InvalidNameKanaError({ reason: "bad" }))
    expect(payload).toEqual({
      __typename: "InvalidNameKana",
      code: "E_VAL_NAME_KANA",
      severity: "validation",
      i18nKey: "error.InvalidNameKana",
    })
  })

  it("carries the domain severity for a domain error", () => {
    expect(errorToGraphQLPayload(new AlreadyCancelledError({})).severity).toBe("domain")
  })

  it("carries the infrastructure severity for an infra error", () => {
    expect(errorToGraphQLPayload(new ConcurrencyError({ expected: 1, actual: 2 })).severity).toBe(
      "infrastructure",
    )
  })
})

describe("errorToGraphQLExtensions", () => {
  const noopRedact = (): Record<string, unknown> => ({})

  it("returns an empty object when the cause is undefined or null", () => {
    expect(errorToGraphQLExtensions(undefined, noopRedact)).toEqual({})
    expect(errorToGraphQLExtensions(null, noopRedact)).toEqual({})
  })

  it("propagates the originating tag from a tagged cause", () => {
    expect(errorToGraphQLExtensions(new AlreadyCancelledError({}), noopRedact)).toEqual({
      originalTag: "AlreadyCancelled",
    })
  })

  it("includes the redactor's payload when it returns fields", () => {
    const redacted = errorToGraphQLExtensions(new Error("boom"), () => ({ name: "Error" }))
    expect(redacted).toEqual({ cause: { name: "Error" } })
  })

  it("merges originalTag and cause when both are present", () => {
    const merged = errorToGraphQLExtensions(new AlreadyCancelledError({}), () => ({ trail: "x" }))
    expect(merged).toEqual({ cause: { trail: "x" }, originalTag: "AlreadyCancelled" })
  })

  it("ignores a non-string _tag on the cause object", () => {
    expect(errorToGraphQLExtensions({ _tag: 42 }, noopRedact)).toEqual({})
  })
})

describe("errorToAuditEntry", () => {
  const ts = "2026-05-08T09:00:00Z"

  it("renders the canonical audit row without traceId", () => {
    const entry = errorToAuditEntry(new InvalidNameKanaError({ reason: "x" }), {
      now: ts,
      actor: "customer",
    })
    expect(entry).toEqual({
      ts,
      actor: "customer",
      outcome: "denied",
      errorTag: "InvalidNameKana",
      errorCode: "E_VAL_NAME_KANA",
    })
  })

  it("includes traceId when the context carries one", () => {
    const traceId = "01HZZZZZZZZZZZZZZZZZZZZZZZ" as TraceId
    const entry = errorToAuditEntry(new StorageError({ reason: "io" }), {
      now: ts,
      actor: "system",
      traceId,
    })
    expect(entry.traceId).toBe(traceId)
    expect(entry.errorTag).toBe("Storage")
    expect(entry.actor).toBe("system")
  })
})
