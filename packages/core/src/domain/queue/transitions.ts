import type { Temporal } from "@js-temporal/polyfill"
import {
  AlreadyCancelledError,
  AlreadyCompletedError,
  AlreadyNoShowError,
  type DomainError,
  InvalidStateTransitionError,
} from "../errors/Errors.js"
import type { BatchId, TicketEventId, TicketId } from "../types/EntityId.js"
import type { FreeText } from "../value-objects/FreeText.js"
import type { NameKana } from "../value-objects/NameKana.js"
import type { PhoneLast4 } from "../value-objects/PhoneLast4.js"
import type { Lane } from "./Lane.js"
import type {
  Actor,
  Called,
  Cancelled,
  NoShow,
  PendingNoShow,
  Served,
  Ticket,
  TicketCommon,
  TicketState,
  Waiting,
} from "./Ticket.js"
import type {
  CalledEvent,
  CancelledEvent,
  CheckedInEvent,
  IssuedEvent,
  NoShowedEvent,
  PendingNoShowMarkedEvent,
  RecalledEvent,
  RescheduledEvent,
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
 * The right-side helpers (`applyIssue`, `applyCall`, …) return
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
  lane: t.lane,
  displaySeq: t.displaySeq,
  nameKana: t.nameKana,
  phoneLast4: t.phoneLast4,
  freeText: t.freeText,
  issuedAt: t.issuedAt,
  appointmentAt: t.appointmentAt,
  checkedInAt: t.checkedInAt,
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
/* inputs (handle + free text + monotonic seq + lane + displaySeq). Returns   */
/* Waiting.                                                                    */
/* -------------------------------------------------------------------------- */

export type IssueArgs = {
  readonly id: TicketId
  readonly seq: number
  readonly lane: Lane
  readonly displaySeq: number
  readonly nameKana: NameKana
  readonly phoneLast4: PhoneLast4
  readonly freeText: FreeText | null
  readonly appointmentAt: Temporal.Instant | null
  readonly at: Temporal.Instant
  readonly eventId: TicketEventId
}

export const applyIssue = (args: IssueArgs): ApplyResult => {
  const ticket: Waiting = {
    id: args.id,
    seq: args.seq,
    lane: args.lane,
    displaySeq: args.displaySeq,
    nameKana: args.nameKana,
    phoneLast4: args.phoneLast4,
    freeText: args.freeText,
    issuedAt: args.at,
    appointmentAt: args.appointmentAt,
    checkedInAt: null,
    state: "Waiting",
  }
  const event: IssuedEvent = {
    ...baseEvent(args.eventId, args.id, args.at),
    type: "Issued",
    seq: args.seq,
    lane: args.lane,
    displaySeq: args.displaySeq,
    nameKana: args.nameKana,
    phoneLast4: args.phoneLast4,
    freeText: args.freeText,
    appointmentAt: args.appointmentAt,
  }
  return { ticket, event }
}

/* -------------------------------------------------------------------------- */
/* Call — Waiting → Called. Used by CallNext (head-of-lane), CallSpecific     */
/* (by-id), and CallBatch (each member). The use case picks the Waiting       */
/* ticket; this helper produces the Called transition uniformly. `batchId`    */
/* is set on CallBatch members only.                                           */
/* -------------------------------------------------------------------------- */

export type CallArgs = {
  readonly at: Temporal.Instant
  readonly eventId: TicketEventId
  readonly calledBy?: Actor
  readonly batchId?: BatchId
}

export const applyCall = (t: Waiting, args: CallArgs): ApplyResult => {
  const calledBy = args.calledBy ?? "staff"
  const ticket: Called = {
    ...common(t),
    state: "Called",
    calledAt: args.at,
    calledBy,
  }
  const event: CalledEvent = {
    ...baseEvent(args.eventId, t.id, args.at),
    type: "Called",
    calledBy,
    ...(args.batchId !== undefined ? { batchId: args.batchId } : {}),
  }
  return { ticket, event }
}

/* -------------------------------------------------------------------------- */
/* MarkServed — Called → Served. ADR-0073 dropped the explicit Serving        */
/* state, so the source narrows to Called only; the projection-time           */
/* "対応中" classification (= called for >= SERVING_THRESHOLD_MS) is a UI     */
/* hint, not a domain state.                                                   */
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
/* MarkNoShow — Called → NoShow. The alarm-driven NoShow sweep targets        */
/* tickets that have been Called past NO_SHOW_TIMEOUT_SECONDS without staff   */
/* intervention; the staff-side flow goes through PendingNoShow first         */
/* (ADR-0074) so this transition is the system / TTL path.                    */
/* -------------------------------------------------------------------------- */

export const applyMarkNoShow = (
  t: Called | PendingNoShow,
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
/* MarkPendingNoShow — Called → PendingNoShow (ADR-0074). Staff hits          */
/* 「来なかった」; the ticket enters the grace window where push notifications */
/* are sent and the customer can choose 「遅れる」 / 「来ない」. The DO alarm  */
/* sweeps any PendingNoShow whose `markedAt + GRACE_TTL_MIN` has elapsed       */
/* into terminal NoShow.                                                       */
/* -------------------------------------------------------------------------- */

export const applyMarkPendingNoShow = (
  t: Called,
  at: Temporal.Instant,
  eventId: TicketEventId,
  markedBy: Actor = "staff",
): ApplyResult => {
  const ticket: PendingNoShow = {
    ...common(t),
    state: "PendingNoShow",
    calledAt: t.calledAt,
    calledBy: t.calledBy,
    markedAt: at,
    markedBy,
  }
  const event: PendingNoShowMarkedEvent = {
    ...baseEvent(eventId, t.id, at),
    type: "PendingNoShowMarked",
    markedBy,
  }
  return { ticket, event }
}

/* -------------------------------------------------------------------------- */
/* Recall — Called → Waiting. Staff-issued reversal of an accidental          */
/* Call: the customer never actually arrived at the counter, so we drop       */
/* the Called-only fields (`calledAt`, `calledBy`) and restore the original   */
/* Waiting shape. The `seq` and `displaySeq` are preserved on purpose — the   */
/* ticket was at the head of its lane when it was called, and the lattice's   */
/* lowest-displaySeq invariant guarantees it will be the head again.          */
/* Audit-wise the call still happened —                                       */
/* the `Recalled` event sits in the log alongside the `Called` event it       */
/* withdraws.                                                                  */
/* -------------------------------------------------------------------------- */

export const applyRecall = (
  t: Called | PendingNoShow,
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
/* Cancel — Waiting | Called → Cancelled. Both customer-issued (self-service) */
/* and staff-issued cancellations land here; the actor records who.           */
/* ADR-0073 dropped the Serving variant, so the source narrows to the two    */
/* pre-terminal states the wire actually carries.                             */
/* -------------------------------------------------------------------------- */

export const applyCancel = (
  t: Waiting | Called | PendingNoShow,
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
/* CheckIn — Waiting → Waiting (ADR-0068). Customer hit the 「到着しました」    */
/* button on /ticket after `now ≥ appointmentAt - 10min`. The ticket stays   */
/* in Waiting (it is not yet at the counter); the CheckedIn event lands in   */
/* the audit log and `checkedInAt` is set on the ticket so the projection's */
/* arrival-vs-called analytics has the data it needs.                        */
/* -------------------------------------------------------------------------- */

export const applyCheckIn = (
  t: Waiting,
  at: Temporal.Instant,
  eventId: TicketEventId,
  checkedInBy: Actor = "customer",
): ApplyResult => {
  const ticket: Waiting = {
    ...common(t),
    state: "Waiting",
    checkedInAt: at,
  }
  const event: CheckedInEvent = {
    ...baseEvent(eventId, t.id, at),
    type: "CheckedIn",
    checkedInBy,
  }
  return { ticket, event }
}

/* -------------------------------------------------------------------------- */
/* Reschedule — atomic appointmentAt swap on a reservation ticket (ADR-0070).  */
/* Same ticketId / seq / displaySeq / handle; only the booked slot moves. The */
/* usecase boundary enforces the lane and slot-capacity guards; this           */
/* transition trusts the caller and emits the audit pair.                     */
/* -------------------------------------------------------------------------- */

export const applyReschedule = (
  t: Waiting | Called | PendingNoShow,
  newAppointmentAt: Temporal.Instant,
  at: Temporal.Instant,
  eventId: TicketEventId,
  rescheduledBy: Actor = "customer",
): ApplyResult => {
  // Lane invariant: only reservation tickets carry an appointmentAt.
  // The usecase already gates on lane === "reservation"; the
  // assertion here is a structural narrowing aid + a runtime
  // safety net should a future caller bypass the boundary.
  /* v8 ignore next */
  if (t.appointmentAt === null) throw new Error("applyReschedule: appointmentAt is null")
  const fromAppointmentAt = t.appointmentAt
  // Preserve `state` exactly — Waiting stays Waiting, Called stays
  // Called. Only `appointmentAt` mutates. The spread preserves the
  // discriminant tag; the result type is the same variant as `t`.
  const ticket: Ticket = { ...t, appointmentAt: newAppointmentAt }
  const event: RescheduledEvent = {
    ...baseEvent(eventId, t.id, at),
    type: "Rescheduled",
    fromAppointmentAt,
    toAppointmentAt: newAppointmentAt,
    rescheduledBy,
  }
  return { ticket, event }
}

/* -------------------------------------------------------------------------- */
/* Terminal-state guards. The use case calls `guardActive` first; if the     */
/* ticket is already terminal the matching `Already*Error` propagates without */
/* the right-side helpers ever being invoked.                                  */
/* -------------------------------------------------------------------------- */

export type TicketCommand =
  | "Reschedule"
  | "CallNext"
  | "CallSpecific"
  | "CallBatch"
  | "MarkServed"
  | "MarkNoShow"
  | "MarkPendingNoShow"
  | "Cancel"
  | "Recall"
  | "CheckIn"

const terminalError = (state: TicketState): DomainError | null => {
  if (state === "Cancelled") return new AlreadyCancelledError({})
  if (state === "Served") return new AlreadyCompletedError({})
  if (state === "NoShow") return new AlreadyNoShowError({})
  return null
}

/**
 * Guard the state machine against a command issued against a terminal
 * ticket. Returns the matching `Already*Error` when the state has no
 * outgoing transition; returns `null` when the ticket is still active
 * (Waiting / Called).
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
