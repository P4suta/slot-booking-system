import { describe, expectTypeOf, it } from "vitest"
import type {
  Capability,
  CustomerCapability,
  StaffCapability,
  SystemCapability,
} from "../../src/domain/auth/Capability.js"
import type { CapabilityFor, CommandOf } from "../../src/domain/booking/Command.js"

/*
 * Type-level negative regression suite for the Command indexed family.
 * Every assertion is evaluated by tsc, so a slip in the schema-level
 * narrowing of `*CommandSchema.capability` shows up at build time
 * instead of as a runtime check that fires only on bad input.
 */

describe("CommandOf<K> indexed family", () => {
  it("Confirm carries no capability field", () => {
    type Confirm = CommandOf<"Confirm">
    expectTypeOf<Confirm>().toExtend<{ readonly kind: "Confirm" }>()
    expectTypeOf<Confirm>().not.toHaveProperty("capability")
  })

  it("Cancel / Reschedule admit any of the three Capability variants", () => {
    type Cancel = CommandOf<"Cancel">
    type Reschedule = CommandOf<"Reschedule">
    expectTypeOf<Cancel["capability"]>().toEqualTypeOf<Capability>()
    expectTypeOf<Reschedule["capability"]>().toEqualTypeOf<Capability>()
  })

  it("Complete / MarkNoShow admit only StaffCapability", () => {
    type Complete = CommandOf<"Complete">
    type MarkNoShow = CommandOf<"MarkNoShow">
    expectTypeOf<Complete["capability"]>().toEqualTypeOf<StaffCapability>()
    expectTypeOf<MarkNoShow["capability"]>().toEqualTypeOf<StaffCapability>()
    expectTypeOf<CustomerCapability>().not.toExtend<Complete["capability"]>()
    expectTypeOf<SystemCapability>().not.toExtend<MarkNoShow["capability"]>()
  })

  it("Expire admits only SystemCapability", () => {
    type Expire = CommandOf<"Expire">
    expectTypeOf<Expire["capability"]>().toEqualTypeOf<SystemCapability>()
    expectTypeOf<CustomerCapability>().not.toExtend<Expire["capability"]>()
    expectTypeOf<StaffCapability>().not.toExtend<Expire["capability"]>()
  })
})

describe("CapabilityFor<K>", () => {
  it("agrees with the per-variant CommandOf capability projection", () => {
    expectTypeOf<CapabilityFor<"Confirm">>().toEqualTypeOf<never>()
    expectTypeOf<CapabilityFor<"Cancel">>().toEqualTypeOf<Capability>()
    expectTypeOf<CapabilityFor<"Reschedule">>().toEqualTypeOf<Capability>()
    expectTypeOf<CapabilityFor<"Complete">>().toEqualTypeOf<StaffCapability>()
    expectTypeOf<CapabilityFor<"MarkNoShow">>().toEqualTypeOf<StaffCapability>()
    expectTypeOf<CapabilityFor<"Expire">>().toEqualTypeOf<SystemCapability>()
  })

  it("rejects mismatched capability assignments at the type level", () => {
    expectTypeOf<CustomerCapability>().not.toExtend<CapabilityFor<"Complete">>()
    expectTypeOf<CustomerCapability>().not.toExtend<CapabilityFor<"MarkNoShow">>()
    expectTypeOf<CustomerCapability>().not.toExtend<CapabilityFor<"Expire">>()
    expectTypeOf<StaffCapability>().not.toExtend<CapabilityFor<"Expire">>()
  })
})
