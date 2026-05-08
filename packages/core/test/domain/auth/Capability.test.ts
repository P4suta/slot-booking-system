import { Result, Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  CapabilitySchema,
  type CustomerCapability,
  CustomerCapabilitySchema,
  hasScope,
  type StaffCapability,
  StaffCapabilitySchema,
  type SystemCapability,
  SystemCapabilitySchema,
  scopeSetOf,
  subjectOf,
} from "../../../src/domain/auth/Capability.js"
import { hasScope as setHasScope } from "../../../src/domain/auth/ScopeSet.js"
import { newStaffId, newTicketId } from "../../../src/domain/types/EntityId.js"

const decodeOrThrow = <S extends Schema.Top>(schema: S, value: unknown): Schema.Schema.Type<S> => {
  const r = Schema.decodeUnknownResult(schema)(value)
  if (Result.isSuccess(r)) return r.success
  throw new Error(`decode failed: ${r.failure}`)
}

const customerCap = (ticketId: string = newTicketId()): CustomerCapability =>
  decodeOrThrow(CustomerCapabilitySchema, {
    _tag: "CustomerCapability",
    ticketId,
    nameKana: "ヤマダ タロウ",
    phoneLast4: "1234",
  })

const staffCap = (staffId: string = newStaffId()): StaffCapability =>
  decodeOrThrow(StaffCapabilitySchema, {
    _tag: "StaffCapability",
    staffId,
    scopes: ["operate_queue"],
  })

const systemCap = (reason: "expire" | "purge" = "expire"): SystemCapability =>
  decodeOrThrow(SystemCapabilitySchema, {
    _tag: "SystemCapability",
    reason,
  })

describe("CapabilitySchema discrimination", () => {
  it.each([
    ["customer", customerCap()],
    ["staff", staffCap()],
    ["system", systemCap()],
  ])("decodes a %s capability", (_label, cap) => {
    const r = Schema.decodeUnknownResult(CapabilitySchema)(cap)
    expect(Result.isSuccess(r)).toBe(true)
  })

  it("rejects an unknown _tag", () => {
    const r = Schema.decodeUnknownResult(CapabilitySchema)({ _tag: "Unknown" })
    expect(Result.isFailure(r)).toBe(true)
  })
})

describe("subjectOf", () => {
  it("projects each variant to its category", () => {
    expect(subjectOf(customerCap())).toBe("customer")
    expect(subjectOf(staffCap())).toBe("staff")
    expect(subjectOf(systemCap())).toBe("system")
  })

  it("system reasons round-trip both arms", () => {
    expect(subjectOf(systemCap("expire"))).toBe("system")
    expect(subjectOf(systemCap("purge"))).toBe("system")
  })
})

describe("scopeSetOf / hasScope", () => {
  it("scopeSetOf reads back operate_queue from a staff cap", () => {
    const s = scopeSetOf(staffCap())
    expect(setHasScope(s, "operate_queue")).toBe(true)
  })

  it("hasScope returns true for a granted scope", () => {
    expect(hasScope(staffCap(), "operate_queue")).toBe(true)
  })
})
