import { Either } from "effect"
import { describe, expect, it } from "vitest"
import {
  AggregateNotFoundError,
  BookingNotFoundError,
  ConcurrencyError,
  codeOf,
  type DomainError,
  InvalidBookingCodeError,
  InvalidPhoneLast4Error,
  InvalidStateTransitionError,
  isTraceId,
  parseTraceId,
  StorageError,
  severityOf,
  type TraceId,
  toLogPayload,
  withMeta,
} from "../../src/domain/errors/index.js"

describe("Data.TaggedError leaves", () => {
  it("carry _tag, name, message, stack", () => {
    const e = new InvalidPhoneLast4Error({ reason: "must be 4 digits" })
    expect(e._tag).toBe("InvalidPhoneLast4")
    expect(e.name).toBe("InvalidPhoneLast4")
    expect(typeof e.stack).toBe("string")
    expect(e.reason).toBe("must be 4 digits")
  })

  it("are instances of their class (instanceof works)", () => {
    const a = new InvalidPhoneLast4Error({ reason: "x" })
    const b = new BookingNotFoundError({})
    expect(a).toBeInstanceOf(InvalidPhoneLast4Error)
    expect(b).toBeInstanceOf(BookingNotFoundError)
    expect(a).not.toBeInstanceOf(BookingNotFoundError)
  })
})

describe("codeOf / severityOf", () => {
  it("returns stable error codes per tag", () => {
    expect(codeOf(new InvalidPhoneLast4Error({ reason: "x" }))).toBe("E_VAL_PHONE_LAST4")
    expect(codeOf(new BookingNotFoundError({}))).toBe("E_DOM_BOOKING_NOT_FOUND")
    expect(codeOf(new InvalidStateTransitionError({ from: "Held", command: "Complete" }))).toBe(
      "E_DOM_INVALID_TRANSITION",
    )
  })

  it("classifies severity (validation vs domain vs infrastructure)", () => {
    expect(severityOf(new InvalidBookingCodeError({ reason: "wrong-length" }))).toBe("validation")
    expect(severityOf(new BookingNotFoundError({}))).toBe("domain")
    expect(severityOf(new AggregateNotFoundError({}))).toBe("infrastructure")
    expect(severityOf(new ConcurrencyError({ expected: 0, actual: 1 }))).toBe("infrastructure")
    expect(severityOf(new StorageError({ reason: "txn aborted" }))).toBe("infrastructure")
  })

  it("returns infra-class codes for port-level failures", () => {
    expect(codeOf(new AggregateNotFoundError({}))).toBe("E_INF_AGG_NOT_FOUND")
    expect(codeOf(new ConcurrencyError({ expected: 0, actual: 1 }))).toBe("E_INF_CONCURRENCY")
    expect(codeOf(new StorageError({ reason: "txn aborted" }))).toBe("E_INF_STORAGE")
  })
})

describe("withMeta", () => {
  it("returns a new error with meta attached without mutating the original", () => {
    const e = new InvalidPhoneLast4Error({ reason: "x" })
    const traceId = Either.getOrThrow(parseTraceId("01H8XRQMKQDNFGXT7NH3AVH3XS"))
    const e2 = withMeta(e, { traceId })
    expect(e.meta).toBeUndefined()
    expect(e2.meta?.traceId).toBe(traceId)
    expect(e2._tag).toBe(e._tag)
    expect(e2).toBeInstanceOf(InvalidPhoneLast4Error)
  })

  it("merges with existing meta", () => {
    const traceId = Either.getOrThrow(parseTraceId("01H8XRQMKQDNFGXT7NH3AVH3XS"))
    const initial = withMeta(new BookingNotFoundError({}), { traceId })
    const extended = withMeta(initial, { context: { bookingCode: "XXXX-YYY" } })
    expect(extended.meta?.traceId).toBe(traceId)
    expect(extended.meta?.context?.bookingCode).toBe("XXXX-YYY")
  })
})

describe("toLogPayload", () => {
  it("emits _tag, code, severity, and the error's data fields", () => {
    const e: DomainError = new InvalidPhoneLast4Error({ reason: "must be 4 digits" })
    const p = toLogPayload(e)
    expect(p._tag).toBe("InvalidPhoneLast4")
    expect(p.code).toBe("E_VAL_PHONE_LAST4")
    expect(p.severity).toBe("validation")
    expect(p.data.reason).toBe("must be 4 digits")
  })

  it("includes traceId and context when meta is present", () => {
    const traceId = Either.getOrThrow(parseTraceId("01H8XRQMKQDNFGXT7NH3AVH3XS"))
    const e = withMeta(new BookingNotFoundError({}), {
      traceId,
      context: { bookingCode: "ABCD-EFG" },
    })
    const p = toLogPayload(e)
    expect(p.traceId).toBe(traceId)
    expect(p.context?.bookingCode).toBe("ABCD-EFG")
  })

  it("serialises an Error cause as { name, message } only — never includes stack", () => {
    const cause = new TypeError("boom")
    const e = withMeta(new BookingNotFoundError({}), { cause })
    const p = toLogPayload(e)
    expect(p.cause?.name).toBe("TypeError")
    expect(p.cause?.message).toBe("boom")
    // Cause object should have exactly { name, message } — no stack key.
    expect(Object.keys(p.cause ?? {})).toEqual(["name", "message"])
  })

  it("drops a non-Error cause", () => {
    const e = withMeta(new BookingNotFoundError({}), { cause: "string-cause" })
    const p = toLogPayload(e)
    expect(p.cause).toBeUndefined()
  })

  it("never surfaces customer PII keys (nameKana, phoneLast4, freeText)", () => {
    // Errors don't carry PII fields by construction. This guards the
    // assertion at the type level: try to find any forbidden key in the
    // payload across every concrete error class.
    const errors: DomainError[] = [
      new InvalidPhoneLast4Error({ reason: "x" }),
      new InvalidBookingCodeError({ reason: "wrong-length" }),
      new BookingNotFoundError({}),
      new InvalidStateTransitionError({ from: "Held", command: "Complete" }),
      new AggregateNotFoundError({}),
      new ConcurrencyError({ expected: 0, actual: 1 }),
      new StorageError({ reason: "txn aborted" }),
    ]
    const forbidden = new Set(["nameKana", "phoneLast4", "freeText", "email", "address"])
    for (const e of errors) {
      const p = toLogPayload(e)
      for (const key of Object.keys(p.data)) {
        expect(forbidden.has(key)).toBe(false)
      }
    }
  })

  it("surfaces ConcurrencyError's expected/actual revisions in log payload", () => {
    const e = new ConcurrencyError({ expected: 3, actual: 5 })
    const p = toLogPayload(e)
    expect(p.data.expected).toBe(3)
    expect(p.data.actual).toBe(5)
  })

  it("surfaces StorageError's reason in log payload", () => {
    const e = new StorageError({ reason: "txn aborted" })
    const p = toLogPayload(e)
    expect(p.data.reason).toBe("txn aborted")
  })
})

describe("TraceId", () => {
  it("accepts a 26-char Crockford ULID body", () => {
    expect(isTraceId("01H8XRQMKQDNFGXT7NH3AVH3XS")).toBe(true)
  })

  it.each([
    "",
    "too-short",
    "01H8XRQMKQDNFGXT7NH3AVH3X",
    "01H8XRQMKQDNFGXT7NH3AVH3XSI",
  ])("rejects %p", (s) => {
    expect(Either.isLeft(parseTraceId(s))).toBe(true)
  })

  it("brand prevents accidental crossover (compile-time assertion)", () => {
    const t = Either.getOrThrow(parseTraceId("01H8XRQMKQDNFGXT7NH3AVH3XS"))
    // t is a TraceId; passing a plain string here would not type-check.
    const echo = (id: TraceId): TraceId => id
    expect(echo(t)).toBe(t)
  })
})
