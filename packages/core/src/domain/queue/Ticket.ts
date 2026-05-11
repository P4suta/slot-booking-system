import { Schema } from "effect"
import { TicketIdSchema } from "../types/EntityId.js"
import { InstantSchema } from "../types/Temporal.js"
import { FreeTextSchema } from "../value-objects/FreeText.js"
import { NameKanaSchema } from "../value-objects/NameKana.js"
import { PhoneLast4Schema } from "../value-objects/PhoneLast4.js"
import { LaneSchema } from "./Lane.js"

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
 * carries. The field set never depends on the current state, so the
 * variant Schemas spread it unchanged.
 *
 * `seq` is a monotonic per-shop counter handed out at `Issue` time
 * (ADR-0051). It is the global total-order anchor — audit-side, every
 * event has a `seq`-derivable position. `displaySeq` is the per-lane
 * FIFO position consumed by UI ordering and `head` (ADR-0065): Issue
 * assigns the next per-lane displaySeq. `lane`
 * partitions the queue per ADR-0062.
 *
 * `appointmentAt` (ADR-0066) is the booked slot start instant for
 * reservation-lane tickets and `null` for walk-in / priority. The
 * round-trip invariant `lane === "reservation" ⇔ appointmentAt !==
 * null` is pinned by property test (Schema cannot encode an
 * inter-field constraint without splitting the variant union 2×).
 *
 * `checkedInAt` (ADR-0068) is set when a reservation customer hits
 * the customer-side check-in button on `/ticket`. It stays null on
 * walk-in tickets (they are implicitly checked in at issue time) and
 * persists through subsequent state transitions so the audit / no-
 * show analytics layer can compare arrival vs. call-time.
 */
const CommonFields = {
  id: TicketIdSchema,
  seq: Schema.Number,
  lane: LaneSchema,
  displaySeq: Schema.Number,
  nameKana: NameKanaSchema,
  phoneLast4: PhoneLast4Schema,
  freeText: Schema.NullOr(FreeTextSchema),
  issuedAt: InstantSchema,
  appointmentAt: Schema.NullOr(InstantSchema),
  checkedInAt: Schema.NullOr(InstantSchema),
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

/**
 * `Serving` sits between `Called` and `Served` (ADR-0063). The
 * NoShow alarm sweeps `Called` only — once a ticket reaches
 * `Serving`, the customer is at the counter and the alarm no
 * longer applies. From the customer's perspective Serving is
 * indistinguishable from Called ("you have been called").
 */
export const ServingSchema = Schema.Struct({
  ...CommonFields,
  state: Schema.Literal("Serving"),
  calledAt: InstantSchema,
  calledBy: ActorSchema,
  servingStartedAt: InstantSchema,
  servingStartedBy: ActorSchema,
})
export type Serving = Schema.Schema.Type<typeof ServingSchema>

export const ServedSchema = Schema.Struct({
  ...CommonFields,
  state: Schema.Literal("Served"),
  calledAt: InstantSchema,
  calledBy: ActorSchema,
  servingStartedAt: Schema.optional(InstantSchema),
  servingStartedBy: Schema.optional(ActorSchema),
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
  ServingSchema,
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

/** The three terminal states with no outgoing transitions. */
export type TerminalTicketState = "Served" | "NoShow" | "Cancelled"

export const TERMINAL_TICKET_STATES: readonly TerminalTicketState[] = [
  "Served",
  "NoShow",
  "Cancelled",
] as const

/** Whether a ticket is in a terminal state. */
export const isTerminal = (t: Ticket): t is TicketT<TerminalTicketState> =>
  (TERMINAL_TICKET_STATES as readonly TicketState[]).includes(t.state)
