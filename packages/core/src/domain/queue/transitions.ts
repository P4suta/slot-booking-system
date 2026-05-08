import type { Temporal } from "@js-temporal/polyfill"
import {
  AlreadyCancelledError,
  AlreadyCompletedError,
  AlreadyNoShowError,
  type DomainError,
  InvalidStateTransitionError,
} from "../errors/Errors.js"
import type { TicketEventId, TicketId } from "../types/EntityId.js"
import type { FreeText } from "../value-objects/FreeText.js"
import type { NameKana } from "../value-objects/NameKana.js"
import type { PhoneLast4 } from "../value-objects/PhoneLast4.js"
import type {
  Actor,
  Called,
  Cancelled,
  NoShow,
  Served,
  Ticket,
  TicketCommon,
  TicketState,
  Waiting,
} from "./Ticket.js"
import type {
  CalledEvent,
  CancelledEvent,
  IssuedEvent,
  NoShowedEvent,
  RecalledEvent,
  ServedEvent,
  TicketEvent,
} from "./TicketEvent.js"

/**
 * Result of every state transition: the next ticket together with the
 * event that produced it. The aggregate and the event are minted in
 * lockstep so a downstream `save` (event-sourced repository) writes
 * both atomically — the projection in the read model never lags the
 * append-only log by more than one transaction.
 *
 * The right-side helpers (`applyIssue`, `applyCallNext`, …) return
 * this directly rather than `Result.Result<ApplyResult, DomainError>`:
 * the source-state argument is type-narrowed at the boundary
 * (`applyMarkServed(t: Called, …)`), so a failure path has no inputs
 * that could trigger it. The use cases are responsible for the
 * pre-condition check (`guardActive` + state-equality), and the
 * helpers commit to a total transformation once those have passed.
 */
export type ApplyResult = {
  readonly ticket: Ticket
  readonly event: TicketEvent
}

const common = (t: TicketCommon): TicketCommon => ({
  id: t.id,
  seq: t.seq,
  nameKana: t.nameKana,
  phoneLast4: t.phoneLast4,
  freeText: t.freeText,
  issuedAt: t.issuedAt,
})

const baseEvent = (id: TicketEventId, ticketId: TicketId, at: Temporal.Instant) =>
  ({
    id,
    ticketId,
    version: 1 as const,
    occurredAt: at,
    recordedAt: at,
  }) as const

/* -------------------------------------------------------------------------- */
/* Issue — the only constructor that synthesises a ticket from non-ticket     */
/* inputs (handle + free text + monotonic seq). Returns Waiting.              */
/* -------------------------------------------------------------------------- */

export type IssueArgs = {
  readonly id: TicketId
  readonly seq: number
  readonly nameKana: NameKana
  readonly phoneLast4: PhoneLast4
  readonly freeText: FreeText | null
  readonly at: Temporal.Instant
  readonly eventId: TicketEventId
}

export const applyIssue = (args: IssueArgs): ApplyResult => {
  const ticket: Waiting = {
    id: args.id,
    seq: args.seq,
    nameKana: args.nameKana,
    phoneLast4: args.phoneLast4,
    freeText: args.freeText,
    issuedAt: args.at,
    state: "Waiting",
  }
  const event: IssuedEvent = {
    ...baseEvent(args.eventId, args.id, args.at),
    type: "Issued",
    seq: args.seq,
    nameKana: args.nameKana,
    phoneLast4: args.phoneLast4,
    freeText: args.freeText,
  }
  return { ticket, event }
}

/* -------------------------------------------------------------------------- */
/* CallNext — Waiting → Called. Right-side smart constructor; the use case   */
/* picks the head-of-queue ticket from the projection and hands it here.       */
/* -------------------------------------------------------------------------- */

export const applyCallNext = (
  t: Waiting,
  at: Temporal.Instant,
  eventId: TicketEventId,
  calledBy: Actor = "staff",
): ApplyResult => {
  const ticket: Called = {
    ...common(t),
    state: "Called",
    calledAt: at,
    calledBy,
  }
  const event: CalledEvent = {
    ...baseEvent(eventId, t.id, at),
    type: "Called",
    calledBy,
  }
  return { ticket, event }
}

/* -------------------------------------------------------------------------- */
/* MarkServed — Called → Served.                                              */
/* -------------------------------------------------------------------------- */

export const applyMarkServed = (
  t: Called,
  at: Temporal.Instant,
  eventId: TicketEventId,
  servedBy: Actor = "staff",
): ApplyResult => {
  const ticket: Served = {
    ...common(t),
    state: "Served",
    calledAt: t.calledAt,
    calledBy: t.calledBy,
    servedAt: at,
    servedBy,
  }
  const event: ServedEvent = {
    ...baseEvent(eventId, t.id, at),
    type: "Served",
    servedBy,
  }
  return { ticket, event }
}

/* -------------------------------------------------------------------------- */
/* MarkNoShow — Called → NoShow. Triggered manually by staff or by the       */
/* DO alarm when the no-show TTL elapses (system actor).                       */
/* -------------------------------------------------------------------------- */

export const applyMarkNoShow = (
  t: Called,
  at: Temporal.Instant,
  eventId: TicketEventId,
  markedBy: Actor = "staff",
): ApplyResult => {
  const ticket: NoShow = {
    ...common(t),
    state: "NoShow",
    calledAt: t.calledAt,
    calledBy: t.calledBy,
    markedAt: at,
    markedBy,
  }
  const event: NoShowedEvent = {
    ...baseEvent(eventId, t.id, at),
    type: "NoShowed",
    markedBy,
  }
  return { ticket, event }
}

/* -------------------------------------------------------------------------- */
/* Recall — Called → Waiting. Staff-issued reversal of an accidental          */
/* CallNext: the customer never actually arrived at the counter, so we drop   */
/* the Called-only fields (`calledAt`, `calledBy`) and restore the original   */
/* Waiting shape. The `seq` is preserved on purpose — the ticket was at the   */
/* head of the queue when it was called, and the lattice's lowest-seq         */
/* invariant guarantees it will be the head again unless someone else has     */
/* meanwhile issued a new ticket with a smaller seq (which the monotonic      */
/* counter forbids). Audit-wise the call still happened — the `Recalled`     */
/* event sits in the log alongside the `Called` event it withdraws.           */
/* -------------------------------------------------------------------------- */

export const applyRecall = (
  t: Called,
  at: Temporal.Instant,
  eventId: TicketEventId,
  recalledBy: Actor = "staff",
): ApplyResult => {
  const ticket: Waiting = {
    ...common(t),
    state: "Waiting",
  }
  const event: RecalledEvent = {
    ...baseEvent(eventId, t.id, at),
    type: "Recalled",
    recalledBy,
  }
  return { ticket, event }
}

/* -------------------------------------------------------------------------- */
/* Cancel — Waiting | Called → Cancelled. Both customer-issued (self-service)*/
/* and staff-issued cancellations land here; the actor records who.            */
/* -------------------------------------------------------------------------- */

export const applyCancel = (
  t: Waiting | Called,
  at: Temporal.Instant,
  eventId: TicketEventId,
  cancelledBy: Actor,
  reason: string,
): ApplyResult => {
  const ticket: Cancelled = {
    ...common(t),
    state: "Cancelled",
    cancelledAt: at,
    cancelledBy,
    reason,
  }
  const event: CancelledEvent = {
    ...baseEvent(eventId, t.id, at),
    type: "Cancelled",
    cancelledBy,
    reason,
  }
  return { ticket, event }
}

/* -------------------------------------------------------------------------- */
/* Terminal-state guards. The use case calls `guardActive` first; if the     */
/* ticket is already terminal the matching `Already*Error` propagates without */
/* the right-side helpers ever being invoked.                                  */
/* -------------------------------------------------------------------------- */

export type TicketCommand = "CallNext" | "MarkServed" | "MarkNoShow" | "Cancel" | "Recall"

const terminalError = (state: TicketState): DomainError | null => {
  if (state === "Cancelled") return new AlreadyCancelledError({})
  if (state === "Served") return new AlreadyCompletedError({})
  if (state === "NoShow") return new AlreadyNoShowError({})
  return null
}

/**
 * Guard the state machine against a command issued against a terminal
 * ticket. Returns the matching `Already*Error` when the state has no
 * outgoing transition; returns `null` when the ticket is still active.
 *
 * The non-terminal cases (`Waiting`, `Called`) fall through; the
 * concrete `apply*` helpers above carry the per-command type narrowing.
 */
export const guardActive = (t: Ticket): DomainError | null => terminalError(t.state)

/**
 * Surface a state-machine rejection as `InvalidStateTransitionError`.
 * Used when a command's allowed source states do not include the
 * actual state — e.g. `MarkServed` against a `Waiting` ticket.
 */
export const invalidTransition = (
  from: TicketState,
  command: TicketCommand,
): InvalidStateTransitionError => new InvalidStateTransitionError({ from, command })
