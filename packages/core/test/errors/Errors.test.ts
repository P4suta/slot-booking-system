import { Either } from "effect"
import { describe, expect, it } from "vitest"
import {
  AggregateNotFoundError,
  BookingNotFoundError,
  ConcurrencyError,
  codeOf,
  type DomainError,
  InvalidBookingCodeError,
  InvalidCatalogInputError,
  InvalidPhoneLast4Error,
  InvalidStateTransitionError,
  isTraceId,
  MissingStaffCapabilityError,
  parseTraceId,
  StorageError,
  severityOf,
  type TraceId,
  toLogPayload,
} from "../../src/domain/errors/index.js"

/**
 * Static structural assertion: every leaf error class declared in
 * `Errors.ts` carries the metadata `metadataOf` reads. The `_typed`
 * assignments would not compile if a leaf class were missing a
 * `static readonly code` / `severity` / inherited `fields`; the
 * `void`-cast then ensures TypeScript treats them as side-effect-only.
 */
type ErrorClassShape = {
  readonly code: string
  readonly severity: "validation" | "domain" | "infrastructure"
  readonly fields: Readonly<Record<string, unknown>>
}
const _assertions: readonly ErrorClassShape[] = [
  InvalidPhoneLast4Error,
  BookingNotFoundError,
  InvalidStateTransitionError,
  AggregateNotFoundError,
  ConcurrencyError,
  StorageError,
  InvalidBookingCodeError,
  InvalidCatalogInputError,
  MissingStaffCapabilityError,
]
void _assertions

describe("Schema.TaggedError leaves", () => {
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

  it("expose the Schema field table on the class side", () => {
    // The factory installs a `fields` static for runtime introspection;
    // `dataOf` enumerates this to build log payloads without ad-hoc
    // string lists or `as unknown as` casts.
    expect(Object.keys(InvalidPhoneLast4Error.fields).sort()).toEqual(["_tag", "reason"].sort())
    expect(Object.keys(StorageError.fields).sort()).toEqual(["_tag", "cause", "reason"].sort())
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

describe("StorageError cause is a first-class field (Phase 2.0 / BI-2)", () => {
  it("preserves an Error cause on the instance", () => {
    const cause = new TypeError("boom")
    const e = new StorageError({ reason: "txn aborted", cause })
    expect(e.cause).toBe(cause)
  })

  it("constructs without a cause when none is supplied", () => {
    const e = new StorageError({ reason: "txn aborted" })
    expect(e.cause).toBeUndefined()
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

  it("attaches a traceId when the call site supplies one", () => {
    const traceId = Either.getOrThrow(parseTraceId("01H8XRQMKQDNFGXT7NH3AVH3XS"))
    const p = toLogPayload(new BookingNotFoundError({}), { traceId })
    expect(p.traceId).toBe(traceId)
  })

  it("omits traceId when no option is supplied", () => {
    const p = toLogPayload(new BookingNotFoundError({}))
    expect(p.traceId).toBeUndefined()
  })

  it("serialises an Error cause as { name, message } only — never includes stack", () => {
    const cause = new TypeError("boom")
    const e = new StorageError({ reason: "txn aborted", cause })
    const p = toLogPayload(e)
    expect(p.cause?.name).toBe("TypeError")
    expect(p.cause?.message).toBe("boom")
    // Cause object should have exactly { name, message } — no stack key.
    expect(Object.keys(p.cause ?? {})).toEqual(["name", "message"])
  })

  it("drops a non-Error cause", () => {
    const e = new StorageError({ reason: "txn aborted", cause: "string-cause" })
    const p = toLogPayload(e)
    expect(p.cause).toBeUndefined()
  })

  it("never surfaces the cause field as part of `data`", () => {
    // `cause` is rendered separately by the cause-preview path; it must
    // not double up under `data`, which is reserved for non-cause payload.
    const e = new StorageError({ reason: "txn aborted", cause: new Error("boom") })
    const p = toLogPayload(e)
    expect(Object.keys(p.data)).toEqual(["reason"])
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

  it("classifies catalog-input + missing-staff-capability as validation", () => {
    expect(
      severityOf(new InvalidCatalogInputError({ entity: "service", reason: "missing name" })),
    ).toBe("validation")
    expect(severityOf(new MissingStaffCapabilityError({ reason: "absent" }))).toBe("validation")
  })

  it("returns stable codes for catalog-input + missing-staff-capability", () => {
    expect(codeOf(new InvalidCatalogInputError({ entity: "service", reason: "x" }))).toBe(
      "E_VAL_CATALOG_INPUT",
    )
    expect(codeOf(new MissingStaffCapabilityError({ reason: "absent" }))).toBe(
      "E_VAL_MISSING_STAFF_CAPABILITY",
    )
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
