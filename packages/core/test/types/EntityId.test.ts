import { Result } from "effect"
import { describe, expect, it } from "vitest"
import {
  ALL_ENTITY_KINDS,
  newAuditLogId,
  newBatchId,
  newIdempotencyKeyId,
  newStaffId,
  newTicketEventId,
  newTicketId,
  parseAuditLogId,
  parseBatchId,
  parseIdempotencyKeyId,
  parseStaffId,
  parseTicketEventId,
  parseTicketId,
} from "../../src/domain/types/EntityId.js"

const isLeft = Result.isFailure
const isRight = Result.isSuccess

describe("ALL_ENTITY_KINDS", () => {
  it("enumerates the queue-pivot kinds", () => {
    expect(ALL_ENTITY_KINDS).toEqual(["tkt", "tev", "staf", "audt", "idem", "bch"])
  })
})

describe("newId factories", () => {
  it("each factory mints an id with the matching prefix", () => {
    expect(newTicketId()).toMatch(/^tkt_[0-9a-z]{26}$/)
    expect(newTicketEventId()).toMatch(/^tev_[0-9a-z]{26}$/)
    expect(newStaffId()).toMatch(/^staf_[0-9a-z]{26}$/)
    expect(newAuditLogId()).toMatch(/^audt_[0-9a-z]{26}$/)
    expect(newIdempotencyKeyId()).toMatch(/^idem_[0-9a-z]{26}$/)
    expect(newBatchId()).toMatch(/^bch_[0-9a-z]{26}$/)
  })

  it("two consecutive mints produce distinct ids", () => {
    expect(newTicketId()).not.toBe(newTicketId())
  })
})

describe("parseId variants", () => {
  // The generic `parseId` family unifies under a heterogeneous Result
  // union; the test helper widens to a single tagged Result so
  // exactOptionalPropertyTypes does not narrow the row type at the
  // Vitest `it.each` boundary.
  type AnyResult = Result.Result<unknown, unknown>
  const parsers: readonly (readonly [string, (s: string) => AnyResult, string])[] = [
    ["TicketId", parseTicketId, "tkt_01h0000000000000000000000a"],
    ["TicketEventId", parseTicketEventId, "tev_01h0000000000000000000000a"],
    ["StaffId", parseStaffId, "staf_01h0000000000000000000000a"],
    ["AuditLogId", parseAuditLogId, "audt_01h0000000000000000000000a"],
    ["IdempotencyKeyId", parseIdempotencyKeyId, "idem_01h0000000000000000000000a"],
    ["BatchId", parseBatchId, "bch_01h0000000000000000000000a"],
  ]
  it.each(parsers)("accepts a well-formed %s", (_label, parser, value) => {
    expect(isRight(parser(value))).toBe(true)
  })

  it.each([
    ["empty", ""],
    ["wrong prefix", "wrong_01h0000000000000000000000a"],
    ["too short", "tkt_01h"],
    ["uppercase", "TKT_01H0000000000000000000000A"],
    ["missing underscore", "tkt01h0000000000000000000000a"],
  ])("rejects %s", (_label, input) => {
    expect(isLeft(parseTicketId(input))).toBe(true)
  })

  it("round-trips a freshly-minted id", () => {
    const minted = newTicketId()
    const parsed = parseTicketId(minted)
    expect(isRight(parsed)).toBe(true)
    if (isRight(parsed)) expect(parsed.success).toBe(minted)
  })
})
