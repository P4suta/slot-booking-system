import { Schema } from "effect"
import type { Capability, StaffCapability, SystemCapability } from "../auth/Capability.js"
import {
  CapabilitySchema,
  StaffCapabilitySchema,
  SystemCapabilitySchema,
} from "../auth/Capability.js"
import { InstantSchema } from "../types/Temporal.js"
import { TimeSlotSchema } from "../value-objects/TimeSlot.js"

/**
 * Command messages issued against a Booking. Discriminated union over
 * `kind`; the pure `apply(state, command, eventId)` pattern-matches
 * the (state, kind) pair and emits a `BookingEvent` on success.
 *
 * Phase 0.7-β1 — every state-changing command (`Cancel`, `Reschedule`,
 * `Complete`, `MarkNoShow`, `Expire`) carries a {@link Capability}
 * field. Schema-level subtype narrowing encodes who may issue the
 * command:
 *
 *   - `Cancel` / `Reschedule` accept the full `CapabilitySchema`
 *     union (customer self-service or staff override both work);
 *   - `Complete` / `MarkNoShow` accept only `StaffCapabilitySchema`;
 *   - `Expire` accepts only `SystemCapabilitySchema`;
 *   - `Confirm` carries no capability — the customer credential check
 *     happens upstream in `authenticateCustomer`.
 *
 * Inside `apply`, the Staff path additionally checks `hasScope` for
 * the required scope (`"cancel"` / `"reschedule"` / `"complete"` /
 * `"noshow"`); a missing scope yields {@link InsufficientCapability}.
 *
 * The legacy `by: "customer" | "staff" | "system"` literal is gone
 * from the wire shape; downstream readers derive the actor category
 * from `subjectOf(capability)` (`Booking.cancelledBy`,
 * `BookingEvent.by`).
 */

const CommandBase = {
  at: InstantSchema,
} as const

export const ConfirmCommandSchema = Schema.Struct({
  ...CommandBase,
  kind: Schema.Literal("Confirm"),
})

export const CancelCommandSchema = Schema.Struct({
  ...CommandBase,
  kind: Schema.Literal("Cancel"),
  reason: Schema.String,
  capability: CapabilitySchema,
})

export const RescheduleCommandSchema = Schema.Struct({
  ...CommandBase,
  kind: Schema.Literal("Reschedule"),
  newSlot: TimeSlotSchema,
  capability: CapabilitySchema,
})

export const CompleteCommandSchema = Schema.Struct({
  ...CommandBase,
  kind: Schema.Literal("Complete"),
  capability: StaffCapabilitySchema,
})

export const MarkNoShowCommandSchema = Schema.Struct({
  ...CommandBase,
  kind: Schema.Literal("MarkNoShow"),
  capability: StaffCapabilitySchema,
})

export const ExpireCommandSchema = Schema.Struct({
  ...CommandBase,
  kind: Schema.Literal("Expire"),
  capability: SystemCapabilitySchema,
})

export const CommandSchema = Schema.Union([
  ConfirmCommandSchema,
  CancelCommandSchema,
  RescheduleCommandSchema,
  CompleteCommandSchema,
  MarkNoShowCommandSchema,
  ExpireCommandSchema,
])

export type Command = Schema.Schema.Type<typeof CommandSchema>
export type CommandKind = Command["kind"]

/**
 * Indexed view: `CommandOf<"Cancel">` is the `CancelCommand` variant,
 * `CommandOf<"Complete">` is the `CompleteCommand` variant, etc. The
 * indexed family exists so use-case call sites and `applyTyped` narrow
 * to a single command shape at the type level rather than carrying the
 * full `Command` union.
 */
export type CommandOf<K extends CommandKind> = Extract<Command, { kind: K }>

/**
 * Type-level capability narrowing — the issuer category each command
 * kind admits. Mirrors the per-variant `capability` field's Schema:
 *
 *   - `Confirm`                       → `never`
 *     (no capability field; auth happens via `authenticateCustomer`)
 *   - `Cancel` | `Reschedule`         → `Capability` (any of three tags)
 *   - `Complete` | `MarkNoShow`       → `StaffCapability`
 *   - `Expire`                        → `SystemCapability`
 *
 * Encodes the schema-level constraint at the type system. Cross-validated
 * at compile time by `test/type/CommandCapability.test.ts`.
 */
export type CapabilityFor<K extends CommandKind> = K extends "Confirm"
  ? never
  : K extends "Cancel" | "Reschedule"
    ? Capability
    : K extends "Complete" | "MarkNoShow"
      ? StaffCapability
      : K extends "Expire"
        ? SystemCapability
        : never
