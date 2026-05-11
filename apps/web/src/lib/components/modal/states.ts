/**
 * `ModalState` algebraic data type (S19 / ADR-0087).
 *
 * The pre-refactor staff + ticket pages tracked modal visibility
 * with N independent booleans. This ADT collapses the 2^N state
 * space into a discriminated union of N+1 named variants; the
 * impossible combinations are *unrepresentable*.
 *
 * Each variant carries any payload it needs (e.g. the ticketId
 * the modal acts on) so the modal host renders from a single
 * `ModalState` value rather than a `(state, payloads...)` cross-
 * product.
 */

/** Customer-facing modals on `/ticket`. */
export type CustomerModalState =
  | { readonly tag: "none" }
  | { readonly tag: "cancelConfirm"; readonly ticketId: string }
  | { readonly tag: "reschedulePicker"; readonly ticketId: string }
  | { readonly tag: "lateAcknowledge"; readonly ticketId: string }
  | { readonly tag: "noComeConfirm"; readonly ticketId: string }
  | { readonly tag: "recoveryHelp" }

/** Staff-facing modals on `/staff`. */
export type StaffModalState =
  | { readonly tag: "none" }
  | { readonly tag: "callConfirm"; readonly ticketId: string }
  | { readonly tag: "servedConfirm"; readonly ticketId: string }
  | { readonly tag: "noShowConfirm"; readonly ticketId: string }
  | { readonly tag: "cancelConfirm"; readonly ticketId: string; readonly reason: string }
  | { readonly tag: "batchCall"; readonly ticketIds: readonly string[] }
  | { readonly tag: "ticketDetail"; readonly ticketId: string }

export const closedCustomer = (): CustomerModalState => ({ tag: "none" })
export const closedStaff = (): StaffModalState => ({ tag: "none" })
