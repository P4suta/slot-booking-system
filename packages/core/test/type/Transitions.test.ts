import { describe, expectTypeOf, it } from "vitest"
import type {
  AllowedCommandKinds,
  BookingMachineState,
  NextState,
  TransitionTable,
} from "../../src/domain/booking/machine.js"

describe("type-level booking transition table", () => {
  it("AllowedCommandKinds enumerates exactly the spec's outgoing edges", () => {
    expectTypeOf<AllowedCommandKinds<"Held">>().toEqualTypeOf<"Confirm" | "Cancel" | "Expire">()
    expectTypeOf<AllowedCommandKinds<"Confirmed">>().toEqualTypeOf<
      "Cancel" | "Reschedule" | "Complete" | "MarkNoShow"
    >()
    expectTypeOf<AllowedCommandKinds<"Cancelled">>().toEqualTypeOf<never>()
    expectTypeOf<AllowedCommandKinds<"Completed">>().toEqualTypeOf<never>()
    expectTypeOf<AllowedCommandKinds<"NoShow">>().toEqualTypeOf<never>()
  })

  it("NextState resolves successors deterministically", () => {
    expectTypeOf<NextState<"Held", "Confirm">>().toEqualTypeOf<"Confirmed">()
    expectTypeOf<NextState<"Held", "Cancel">>().toEqualTypeOf<"Cancelled">()
    expectTypeOf<NextState<"Held", "Expire">>().toEqualTypeOf<"Cancelled">()
    expectTypeOf<NextState<"Confirmed", "Reschedule">>().toEqualTypeOf<"Confirmed">()
    expectTypeOf<NextState<"Confirmed", "Complete">>().toEqualTypeOf<"Completed">()
    expectTypeOf<NextState<"Confirmed", "MarkNoShow">>().toEqualTypeOf<"NoShow">()
    expectTypeOf<NextState<"Confirmed", "Cancel">>().toEqualTypeOf<"Cancelled">()
  })

  it("TransitionTable covers every BookingMachineState as a key", () => {
    type Keys = keyof TransitionTable
    expectTypeOf<Keys>().toEqualTypeOf<BookingMachineState>()
  })
})
