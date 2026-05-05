/**
 * Specification of the Booking lifecycle as a pure adjacency table.
 * The transition map below is the **single source of truth**; the
 * implementation in `transitions.ts` (`apply`) is cross-validated
 * against it by `machine.test.ts`.
 *
 * The spec carries no domain data — it is intentionally context-free
 * so it can be visualised by an external renderer (DOT/Mermaid emitter
 * is one short pure function away) without leaking PII or fixtures.
 *
 * Five states (`Held`, `Confirmed`, `Cancelled`, `Completed`, `NoShow`)
 * mirror `Booking["state"]`. Six command-typed events (`Confirm`,
 * `Cancel`, `Expire`, `Reschedule`, `Complete`, `MarkNoShow`) mirror
 * `Command["kind"]`. The terminal-state semantics from `transitions.ts`
 * are reified in `TERMINAL`.
 *
 * History (Phase 0.6 / ADR-0031): the previous version constructed an
 * xstate v5 `createMachine(...)` from this same table. The xstate value
 * was used by exactly one test (`bookingMachine.states.keys`); every
 * other consumer read from `TRANSITIONS` directly. Dropping the
 * xstate runtime dependency removes ~30 KB from the bundle and one
 * external surface, with no semantic loss — the table *is* the
 * specification, and `keyof typeof TRANSITIONS[State]` already gives
 * us compile-time exhaustiveness over the (state, event) lattice.
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
 * Adjacency table mirroring the booking state graph. Editing this table
 * editsthe specification — `apply` is cross-validated against it in
 * `machine.test.ts`. Self-loops (e.g. Reschedule on Confirmed) appear
 * explicitly so they round-trip through `machineNext`.
 */
export const TRANSITIONS: Readonly<
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

/**
 * Whether `state` accepts no further commands. Three terminal states;
 * `apply` rejects every command for them. Re-derivable as
 * `Object.keys(TRANSITIONS[state]).length === 0` but materialised here
 * for documentation symmetry with the xstate predecessor.
 */
export const TERMINAL: Readonly<Record<BookingMachineState, boolean>> = {
  Held: false,
  Confirmed: false,
  Cancelled: true,
  Completed: true,
  NoShow: true,
}

/** Pure predicate: would `eventType` cause a transition out of `state`? */
export const machineAllows = (
  state: BookingMachineState,
  eventType: BookingMachineEventType,
): boolean => eventType in TRANSITIONS[state]

/**
 * Successor state for a (state, event) pair, or `null` when the
 * pair is not in the spec.
 */
export const machineNext = (
  state: BookingMachineState,
  eventType: BookingMachineEventType,
): BookingMachineState | null => TRANSITIONS[state][eventType] ?? null
