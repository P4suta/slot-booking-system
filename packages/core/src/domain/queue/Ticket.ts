import { Schema } from "effect"
import { TicketIdSchema } from "../types/EntityId.js"
import { InstantSchema } from "../types/Temporal.js"
import { FreeTextSchema } from "../value-objects/FreeText.js"
import { NameKanaSchema } from "../value-objects/NameKana.js"
import { PhoneLast4Schema } from "../value-objects/PhoneLast4.js"

/* -------------------------------------------------------------------------- */
/* Discriminator enums                                                         */
/* -------------------------------------------------------------------------- */

/** Who initiated a state-changing action. */
export const ActorSchema = Schema.Literals(["customer", "staff", "system"])
export type Actor = Schema.Schema.Type<typeof ActorSchema>

/* -------------------------------------------------------------------------- */
/* Common-fields fragment                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Identity + immutable customer-side payload every ticket variant
 * carries. Mirrors the slot-graph's `BookingCommon` pattern: the field
 * set never depends on the current state, so the variant Schemas
 * spread it unchanged.
 *
 * `seq` is a monotonic per-day counter handed out at `Issue` time
 * (ADR-0051). It powers the O(1) "your position is N" projection
 * without re-walking the event log.
 */
const CommonFields = {
  id: TicketIdSchema,
  seq: Schema.Number,
  nameKana: NameKanaSchema,
  phoneLast4: PhoneLast4Schema,
  freeText: Schema.NullOr(FreeTextSchema),
  issuedAt: InstantSchema,
} as const

export const TicketCommonSchema = Schema.Struct(CommonFields)
export type TicketCommon = Schema.Schema.Type<typeof TicketCommonSchema>

/* -------------------------------------------------------------------------- */
/* Variant Schemas                                                             */
/* -------------------------------------------------------------------------- */

export const WaitingSchema = Schema.Struct({
  ...CommonFields,
  state: Schema.Literal("Waiting"),
})
export type Waiting = Schema.Schema.Type<typeof WaitingSchema>

export const CalledSchema = Schema.Struct({
  ...CommonFields,
  state: Schema.Literal("Called"),
  calledAt: InstantSchema,
  calledBy: ActorSchema,
})
export type Called = Schema.Schema.Type<typeof CalledSchema>

export const ServedSchema = Schema.Struct({
  ...CommonFields,
  state: Schema.Literal("Served"),
  calledAt: InstantSchema,
  calledBy: ActorSchema,
  servedAt: InstantSchema,
  servedBy: ActorSchema,
})
export type Served = Schema.Schema.Type<typeof ServedSchema>

export const NoShowSchema = Schema.Struct({
  ...CommonFields,
  state: Schema.Literal("NoShow"),
  calledAt: InstantSchema,
  calledBy: ActorSchema,
  markedAt: InstantSchema,
  markedBy: ActorSchema,
})
export type NoShow = Schema.Schema.Type<typeof NoShowSchema>

export const CancelledSchema = Schema.Struct({
  ...CommonFields,
  state: Schema.Literal("Cancelled"),
  cancelledAt: InstantSchema,
  cancelledBy: ActorSchema,
  reason: Schema.String,
})
export type Cancelled = Schema.Schema.Type<typeof CancelledSchema>

/* -------------------------------------------------------------------------- */
/* Aggregate union + type-state phantom                                        */
/* -------------------------------------------------------------------------- */

export const TicketSchema = Schema.Union([
  WaitingSchema,
  CalledSchema,
  ServedSchema,
  NoShowSchema,
  CancelledSchema,
])
export type Ticket = Schema.Schema.Type<typeof TicketSchema>

export type TicketState = Ticket["state"]

/**
 * Type-state phantom — `TicketT<S>` is the variant whose `state` arm
 * equals `S`. Call sites that have already narrowed state can pin the
 * type at compile time; mismatched commands fail to type-check rather
 * than fall to a runtime `InvalidStateTransition`.
 */
export type TicketT<S extends TicketState> = Extract<Ticket, { state: S }>

/** The two terminal states with no outgoing transitions. */
export type TerminalTicketState = "Served" | "NoShow" | "Cancelled"

export const TERMINAL_TICKET_STATES: readonly TerminalTicketState[] = [
  "Served",
  "NoShow",
  "Cancelled",
] as const

/** Whether a ticket is in a terminal state. */
export const isTerminal = (t: Ticket): t is TicketT<TerminalTicketState> =>
  (TERMINAL_TICKET_STATES as readonly TicketState[]).includes(t.state)
