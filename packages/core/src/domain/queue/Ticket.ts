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
 * `PendingNoShow` (ADR-0074) sits between `Called` and the terminal
 * states. Staff hits 「来なかった」 → the ticket enters this state
 * and the customer receives a push prompt to choose between
 * 「遅れる」 (= Recall back to Waiting, or Reschedule for reservation)
 * and 「来ない」 (= Cancelled). After `markedAt + GRACE_TTL_MIN` with
 * no customer response, the DO alarm sweeps the ticket into `NoShow`.
 */
export const PendingNoShowSchema = Schema.Struct({
  ...CommonFields,
  state: Schema.Literal("PendingNoShow"),
  calledAt: InstantSchema,
  calledBy: ActorSchema,
  markedAt: InstantSchema,
  markedBy: ActorSchema,
})
export type PendingNoShow = Schema.Schema.Type<typeof PendingNoShowSchema>

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
  PendingNoShowSchema,
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

/** The three active (non-terminal) states with at least one outgoing transition. */
export type ActiveTicketState = "Waiting" | "Called" | "PendingNoShow"

export const TERMINAL_TICKET_STATES: readonly TerminalTicketState[] = [
  "Served",
  "NoShow",
  "Cancelled",
] as const

export const ACTIVE_TICKET_STATES: readonly ActiveTicketState[] = [
  "Waiting",
  "Called",
  "PendingNoShow",
] as const

/* -------------------------------------------------------------------------- */
/* Central type-guard registry (ADR-0079)                                      */
/*                                                                             */
/* Each guard narrows `Ticket` to the corresponding `TicketT<S>` variant so a  */
/* call site that branches on a guard inherits the state-dependent fields     */
/* (`calledAt` on `TicketT<"Called">`, `markedAt` on `TicketT<"PendingNoShow"> */
/* …) at the type level without a second narrow. Previously each consumer    */
/* (projection.ts, web routes, use-case files) redeclared these locally —    */
/* one drift away from a runtime `InvalidStateTransition` slipping past tsc. */
/* -------------------------------------------------------------------------- */

export const isWaiting = (t: Ticket): t is TicketT<"Waiting"> => t.state === "Waiting"
export const isCalled = (t: Ticket): t is TicketT<"Called"> => t.state === "Called"
export const isPendingNoShow = (t: Ticket): t is TicketT<"PendingNoShow"> =>
  t.state === "PendingNoShow"
export const isServed = (t: Ticket): t is TicketT<"Served"> => t.state === "Served"
export const isNoShowState = (t: Ticket): t is TicketT<"NoShow"> => t.state === "NoShow"
export const isCancelled = (t: Ticket): t is TicketT<"Cancelled"> => t.state === "Cancelled"

/** Whether a ticket is in a terminal state. */
export const isTerminal = (t: Ticket): t is TicketT<TerminalTicketState> =>
  (TERMINAL_TICKET_STATES as readonly TicketState[]).includes(t.state)

/** Whether a ticket is in an active (non-terminal) state. */
export const isActive = (t: Ticket): t is TicketT<ActiveTicketState> =>
  (ACTIVE_TICKET_STATES as readonly TicketState[]).includes(t.state)
