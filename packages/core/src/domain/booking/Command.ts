import { Schema } from "effect"
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
