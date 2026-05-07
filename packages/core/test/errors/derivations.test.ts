import { describe, expect, it } from "vitest"
import {
  errorToAuditEntry,
  errorToGraphQLPayload,
  errorToI18nKey,
} from "../../src/domain/errors/derivations.js"
import {
  AggregateNotFoundError,
  BookingNotFoundError,
  ConcurrencyError,
  InsufficientCapabilityError,
  InvalidStateTransitionError,
  PhoneMismatchError,
} from "../../src/domain/errors/Errors.js"
import { parseTraceId } from "../../src/domain/errors/TraceId.js"

describe("errorToI18nKey", () => {
  it("renders `error.<_tag>` for every error class", () => {
    expect(errorToI18nKey(new BookingNotFoundError({}))).toBe("error.BookingNotFound")
    expect(errorToI18nKey(new PhoneMismatchError({}))).toBe("error.PhoneMismatch")
    expect(
      errorToI18nKey(new InvalidStateTransitionError({ from: "Held", command: "Complete" })),
    ).toBe("error.InvalidStateTransition")
    expect(
      errorToI18nKey(
        new InsufficientCapabilityError({ required: "complete", capability: "StaffCapability" }),
      ),
    ).toBe("error.InsufficientCapability")
  })
})

describe("errorToGraphQLPayload", () => {
  it("carries __typename, code, severity, and i18nKey for the Pothos errors plugin", () => {
    const payload = errorToGraphQLPayload(new BookingNotFoundError({}))
    expect(payload.__typename).toBe("BookingNotFound")
    expect(payload.code).toBe("E_DOM_BOOKING_NOT_FOUND")
    expect(payload.severity).toBe("domain")
    expect(payload.i18nKey).toBe("error.BookingNotFound")
  })

  it("infrastructure errors surface a different severity", () => {
    const payload = errorToGraphQLPayload(new ConcurrencyError({ expected: 0, actual: 1 }))
    expect(payload.severity).toBe("infrastructure")
    expect(payload.code).toBe("E_INF_CONCURRENCY")
  })
})

describe("errorToAuditEntry", () => {
  it("builds an audit row with timestamp, actor, outcome=denied, error tag, and code", () => {
    const entry = errorToAuditEntry(new BookingNotFoundError({}), {
      now: "2026-05-09T12:00:00Z",
      actor: "customer",
    })
    expect(entry.ts).toBe("2026-05-09T12:00:00Z")
    expect(entry.actor).toBe("customer")
    expect(entry.outcome).toBe("denied")
    expect(entry.errorTag).toBe("BookingNotFound")
    expect(entry.errorCode).toBe("E_DOM_BOOKING_NOT_FOUND")
    expect("traceId" in entry).toBe(false)
  })

  it("includes traceId when provided in the context", () => {
    const traceId = parseTraceId("01JBFB7NZPMKCR8JJTDRCKF2QM")
    if (traceId._tag !== "Success") throw new Error("ulid-shaped trace id should parse")
    const entry = errorToAuditEntry(new AggregateNotFoundError({}), {
      now: "2026-05-09T12:00:00Z",
      actor: "system",
      traceId: traceId.success,
    })
    expect("traceId" in entry).toBe(true)
    expect(entry.traceId).toBe(traceId.success)
  })
})
