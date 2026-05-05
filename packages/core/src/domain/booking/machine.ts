/**
 * Specification of the Booking lifecycle as a typed adjacency table.
 * The {@link TransitionTable} type is the **single source of truth at
 * the type level**; the runtime constant {@link TRANSITIONS} is its
 * value-level mirror, and `apply` in `transitions.ts` is cross-validated
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
 * xstate v5 `createMachine(...)` from this same table. Phase 0.7-α3
 * promotes the table to the type level so callers can derive
 * `AllowedCommandKinds<S>` and `NextState<S, K>` at compile time —
 * the (state, command) lattice is now queryable as a mapped type, not
 * just an `Object.keys` lookup.
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
 * Type-level adjacency lattice over `(state, event) → state`. Empty
 * objects encode terminal states (no outgoing edges). The runtime
 * {@link TRANSITIONS} satisfies this type, so a missing or misnamed
 * entry is a compile-time error.
 */
export type TransitionTable = {
  readonly Held: {
    readonly Confirm: "Confirmed"
    readonly Cancel: "Cancelled"
    readonly Expire: "Cancelled"
  }
  readonly Confirmed: {
    readonly Cancel: "Cancelled"
    readonly Reschedule: "Confirmed"
    readonly Complete: "Completed"
    readonly MarkNoShow: "NoShow"
  }
  readonly Cancelled: Record<never, never>
  readonly Completed: Record<never, never>
  readonly NoShow: Record<never, never>
}

/**
 * Adjacency table mirroring the booking state graph. Editing this
 * value (and its corresponding {@link TransitionTable} entry) edits
 * the specification — `apply` is cross-validated against it in
 * `machine.test.ts`. Self-loops (e.g. Reschedule on Confirmed) appear
 * explicitly so they round-trip through `machineNext`.
 */
export const TRANSITIONS: TransitionTable = {
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
} as const

/**
 * Command kinds that are valid while in state `S`. Equivalent to
 * `keyof TransitionTable[S]`, intersected with the closed
 * `BookingMachineEventType` union to keep stray strings out of the
 * type. Terminal states resolve to `never`, which makes
 * `applyTyped(b, c)` (Phase 0.7+ overload) refuse to compile when
 * `b` is in a terminal state.
 */
export type AllowedCommandKinds<S extends BookingMachineState> = keyof TransitionTable[S] &
  BookingMachineEventType

/**
 * Successor state when command `K` is dispatched while in state `S`.
 * `K` is constrained to `AllowedCommandKinds<S>`, so an invalid
 * (state, command) pair is rejected at the call site.
 */
export type NextState<
  S extends BookingMachineState,
  K extends AllowedCommandKinds<S>,
> = TransitionTable[S][K] extends BookingMachineState ? TransitionTable[S][K] : never

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
): BookingMachineState | null => {
  const row = TRANSITIONS[state] as Readonly<Record<string, BookingMachineState | undefined>>
  return row[eventType] ?? null
}
