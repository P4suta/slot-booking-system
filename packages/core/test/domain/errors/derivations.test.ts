import {
  AlreadyCancelledError,
  ConcurrencyError,
  errorToAuditEntry,
  errorToI18nKey,
  InvalidNameKanaError,
  StorageError,
  type TraceId,
} from "@booking/core"
import { describe, expect, it } from "vitest"

describe("errorToI18nKey", () => {
  it("returns `error.<_tag>` verbatim", () => {
    expect(errorToI18nKey(new InvalidNameKanaError({ reason: "x" }))).toBe("error.InvalidNameKana")
    expect(errorToI18nKey(new AlreadyCancelledError({}))).toBe("error.AlreadyCancelled")
    expect(errorToI18nKey(new ConcurrencyError({ expected: 1, actual: 2 }))).toBe(
      "error.Concurrency",
    )
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
