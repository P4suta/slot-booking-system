import { createMachine } from "xstate"

/**
 * Declarative xstate v5 description of the Booking lifecycle. This is
 * the **specification** of the state graph; the implementation lives in
 * `transitions.ts` (`apply`). The two are cross-validated by
 * `transitions.test.ts` so any drift between the diagram and the
 * implementation surfaces immediately.
 *
 * The machine carries no domain data — it is intentionally
 * context-free so its emitted form can be rendered as an SVG by the
 * xstate inspector or stately.ai without leaking PII or fixtures.
 *
 * Five states (`Held`, `Confirmed`, `Cancelled`, `Completed`, `NoShow`)
 * mirror `Booking["state"]`. Six command-typed events
 * (`Confirm`, `Cancel`, `Expire`, `Reschedule`, `Complete`, `MarkNoShow`)
 * mirror `Command["kind"]`. The terminal-state semantics from
 * `transitions.ts` are encoded as `type: "final"` on Cancelled /
 * Completed / NoShow.
 */

export type BookingMachineState = "Held" | "Confirmed" | "Cancelled" | "Completed" | "NoShow"

export type BookingMachineEventType =
  | "Confirm"
  | "Cancel"
  | "Expire"
  | "Reschedule"
  | "Complete"
  | "MarkNoShow"

/**
 * Adjacency list mirroring the machine's transition map. Kept as a
 * const so `machineAllows` is a pure lookup; the static layout below is
 * the **only** source of truth — `bookingMachine` is constructed from
 * this same table, so editing one updates the other automatically.
 */
const TRANSITIONS: Readonly<
  Record<
    BookingMachineState,
    Readonly<Partial<Record<BookingMachineEventType, BookingMachineState>>>
  >
> = {
  Held: {
    Confirm: "Confirmed",
    Cancel: "Cancelled",
    Expire: "Cancelled",
  },
  Confirmed: {
    Cancel: "Cancelled",
    Reschedule: "Confirmed",
    Complete: "Completed",
    MarkNoShow: "NoShow",
  },
  Cancelled: {},
  Completed: {},
  NoShow: {},
}

const TERMINAL: Readonly<Record<BookingMachineState, boolean>> = {
  Held: false,
  Confirmed: false,
  Cancelled: true,
  Completed: true,
  NoShow: true,
}

export const bookingMachine = createMachine({
  id: "booking",
  initial: "Held",
  states: Object.fromEntries(
    (Object.keys(TRANSITIONS) as BookingMachineState[]).map((state) => [
      state,
      {
        ...(TERMINAL[state] ? { type: "final" as const } : {}),
        on: Object.fromEntries(
          Object.entries(TRANSITIONS[state]).map(([eventType, target]) => [eventType, target]),
        ),
      },
    ]),
  ),
})

/**
 * Pure predicate over the spec: would `eventType` cause a transition
 * out of `state`? Used by `transitions.test.ts` to cross-validate
 * `apply` against this declarative state graph.
 */
export const machineAllows = (
  state: BookingMachineState,
  eventType: BookingMachineEventType,
): boolean => eventType in TRANSITIONS[state]

/**
 * The state `eventType` would transition `state` to. Returns `null`
 * when the (state, event) pair is not in the spec.
 */
export const machineNext = (
  state: BookingMachineState,
  eventType: BookingMachineEventType,
): BookingMachineState | null => TRANSITIONS[state][eventType] ?? null
