import { Schema } from "effect"
import { InstantSchema } from "../types/Temporal.js"
import { TimeSlotSchema } from "../value-objects/TimeSlot.js"
import { ActorSchema } from "./Booking.js"

/**
 * Command messages issued against a Booking. Discriminated union over
 * `kind`; the pure `apply(state, command, eventId)` pattern-matches
 * the (state, kind) pair and emits a `BookingEvent` on success.
 *
 * Phase 0.6 (T1-F) — every variant is now an Effect.Schema, so:
 *   - HTTP/GraphQL boundary parsing is a `Schema.decodeUnknownEither`
 *     of the union, no hand-written type guards
 *   - fast-check Arbitraries are derivable from the schema (T2-A)
 *   - the round-trip `encode(decode(x)) === x` is testable
 *
 * The legacy `by: Actor` literal stays for now alongside the new
 * `Capability` newtype in `domain/auth`. Phase 1 auth replaces it,
 * but that change is staged behind the auth implementation rather
 * than landed empty here.
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
  by: ActorSchema,
})

export const RescheduleCommandSchema = Schema.Struct({
  ...CommandBase,
  kind: Schema.Literal("Reschedule"),
  newSlot: TimeSlotSchema,
})

export const CompleteCommandSchema = Schema.Struct({
  ...CommandBase,
  kind: Schema.Literal("Complete"),
})

export const MarkNoShowCommandSchema = Schema.Struct({
  ...CommandBase,
  kind: Schema.Literal("MarkNoShow"),
  by: ActorSchema,
})

export const ExpireCommandSchema = Schema.Struct({
  ...CommandBase,
  kind: Schema.Literal("Expire"),
})

export const CommandSchema = Schema.Union(
  ConfirmCommandSchema,
  CancelCommandSchema,
  RescheduleCommandSchema,
  CompleteCommandSchema,
  MarkNoShowCommandSchema,
  ExpireCommandSchema,
)

export type Command = Schema.Schema.Type<typeof CommandSchema>
export type CommandKind = Command["kind"]
