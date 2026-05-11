/**
 * Dispatcher — QueueAction × QueueResult Mealy machine.
 *
 * Each `QueueAction` variant maps onto a use case from
 * `application/usecases/queue/`; the use case returns an
 * `Effect.Effect<DispatchOk, DispatchErr, DispatchDeps>` over the
 * standard four-port layer (Clock + IdGenerator + TicketRepository
 * + Logger). `runDispatch` wraps the use case in
 * `Effect.matchCauseEffect` so success + failure both land on
 * `QueueResult` — the structured-log call on the failure branch
 * stays here so the trace shape is consistent.
 *
 * The Dispatcher does not own the surrounding side effects: the
 * QueueShop facade calls `broadcaster.publish` + `scheduler.sync`
 * in its own epilogue. This keeps the spoke pure (a function from
 * action + repo handle to Effect), so we can unit-test the switch
 * + result-shape mapping without spinning up a DurableObjectStub.
 */
import {
  type BusinessTimeZone,
  CallBatch,
  CallNext,
  CallSpecific,
  CancelTicket,
  CheckIn,
  type Clock,
  type ConcurrencyError,
  type CustomerHandle,
  codeOf,
  type DomainError,
  type EncodedTicket,
  encodeTicket,
  type IdGenerator,
  InstantSchema,
  IssueTicket,
  type Lane,
  type Logger,
  MarkNoShow,
  MarkPendingNoShow,
  MarkServed,
  type NonEmptyReadonlyArray,
  Recall,
  RescheduleTicket,
  type StorageError,
  type Ticket,
  type TicketId,
  type TicketRepository,
} from "@booking/core"
import { Cause, Effect, Schema } from "effect"

/**
 * Action dispatched by the worker to the single QueueShop instance.
 * Discriminated union over the use cases; the DO routes each action
 * through the matching `application/usecases/queue/` entry point.
 *
 * Per ADR-0062 / ADR-0065 the operator-grade actions (CallSpecific
 * / CallBatch) join the original five so the action surface stays
 * small (8 total) but each operator intent has a named entry.
 * ADR-0063's StartServing was withdrawn in ADR-0073.
 */
export type QueueAction =
  | {
      type: "IssueTicket"
      handle: CustomerHandle
      freeText: string | null
      lane?: Lane
      // ISO-8601 instant string. The DO RPC boundary serialises every
      // arg through structuredClone, which rejects Temporal.Instant —
      // the conversion to/from `Temporal.Instant` happens inside the
      // dispatch closure so the wire stays JSON-safe.
      appointmentAt?: string
    }
  | { type: "CallNext"; actor: "staff" | "system"; lane?: Lane }
  | { type: "CallSpecific"; ticketId: TicketId; actor: "staff" | "system" }
  | { type: "CallBatch"; ticketIds: NonEmptyReadonlyArray<TicketId>; actor: "staff" | "system" }
  | { type: "MarkServed"; ticketId: TicketId }
  | { type: "MarkNoShow"; ticketId: TicketId; actor: "staff" | "system" }
  | { type: "MarkPendingNoShow"; ticketId: TicketId; actor: "staff" | "system" }
  | { type: "Recall"; ticketId: TicketId; actor: "staff" | "system" | "customer" }
  | {
      type: "CancelTicket"
      ticketId: TicketId
      actor: "customer" | "staff"
      reason: string
      handle?: CustomerHandle
    }
  | { type: "CheckIn"; ticketId: TicketId }
  | {
      type: "RescheduleTicket"
      ticketId: TicketId
      newAppointmentAt: string
      granularity: 15 | 30 | 60
      tz: string
      capacity: number
      actor: "customer" | "staff"
      handle?: CustomerHandle
    }

/**
 * Result envelope. Single-ticket actions return `ticket`; CallBatch
 * returns `tickets` (the array of every member that landed Called).
 * Failure carries the `_tag + code` pair the boundary surfaces.
 *
 * `merged` (ADR-0069) is set on the single-ticket variant when an
 * IssueTicket call short-circuited to an existing active ticket
 * (handle already held). The HTTP layer surfaces this as 200 OK
 * (vs 201 Created for a fresh issue).
 */
export type QueueResult =
  | { ok: true; ticket: EncodedTicket; merged?: boolean }
  | { ok: true; tickets: readonly EncodedTicket[] }
  | { ok: true }
  | { ok: false; error: { _tag: string; code: string } }

type DispatchOk = Ticket | readonly Ticket[] | undefined
type DispatchErr = DomainError | ConcurrencyError | StorageError
type DispatchDeps = Clock | IdGenerator | TicketRepository | Logger

const buildEffect = (action: QueueAction): Effect.Effect<DispatchOk, DispatchErr, DispatchDeps> => {
  switch (action.type) {
    case "IssueTicket": {
      const appointmentAt =
        action.appointmentAt !== undefined
          ? Schema.decodeUnknownSync(InstantSchema)(action.appointmentAt)
          : undefined
      return IssueTicket({
        handle: action.handle,
        freeText: action.freeText as Ticket["freeText"],
        ...(action.lane !== undefined ? { lane: action.lane } : {}),
        ...(appointmentAt !== undefined ? { appointmentAt } : {}),
      })
    }
    case "CallNext":
      return CallNext(action.lane, action.actor)
    case "CallSpecific":
      return CallSpecific(action.ticketId, action.actor)
    case "CallBatch":
      return CallBatch(action.ticketIds, action.actor)
    case "MarkServed":
      return MarkServed(action.ticketId)
    case "MarkNoShow":
      return MarkNoShow(action.ticketId, action.actor)
    case "MarkPendingNoShow":
      return MarkPendingNoShow(action.ticketId, action.actor)
    case "Recall":
      return Recall(action.ticketId, action.actor)
    case "CancelTicket":
      return CancelTicket(action.ticketId, action.actor, action.reason, action.handle)
    case "CheckIn":
      return CheckIn(action.ticketId)
    case "RescheduleTicket": {
      const newAppointmentAt = Schema.decodeUnknownSync(InstantSchema)(action.newAppointmentAt)
      return RescheduleTicket({
        ticketId: action.ticketId,
        newAppointmentAt,
        granularity: action.granularity,
        tz: action.tz as BusinessTimeZone,
        capacity: action.capacity,
        actor: action.actor,
        ...(action.handle !== undefined ? { handle: action.handle } : {}),
      })
    }
  }
}

/**
 * Run an action against the runtime layer. `issueExistedId` is the
 * pre-action handle lookup the QueueShop performs for `IssueTicket`
 * (ADR-0069) so the result can carry `merged: true` when the use
 * case short-circuits to an existing active ticket.
 */
export const runDispatch = (
  action: QueueAction,
  issueExistedId: string | undefined,
): Effect.Effect<QueueResult, never, DispatchDeps> =>
  Effect.matchCauseEffect(buildEffect(action), {
    onSuccess: (out: DispatchOk): Effect.Effect<QueueResult> => {
      if (out === undefined) {
        // CheckIn returns void — the customer-side audit event
        // does not change the ticket shape the wire surfaces;
        // the projection broadcast emitted below is enough.
        return Effect.succeed({ ok: true } satisfies QueueResult)
      }
      if (Array.isArray(out)) {
        const tickets = out as readonly Ticket[]
        return Effect.succeed({
          ok: true,
          tickets: tickets.map(encodeTicket),
        } satisfies QueueResult)
      }
      const ticket = out as Ticket
      const merged = issueExistedId !== undefined && issueExistedId === ticket.id
      return Effect.succeed({
        ok: true,
        ticket: encodeTicket(ticket),
        ...(merged ? { merged: true } : {}),
      } satisfies QueueResult)
    },
    onFailure: (cause) => {
      const fails = cause.reasons.filter(Cause.isFailReason)
      const first = fails[0]?.error
      console.error(
        JSON.stringify({
          _tag: "DispatchFailure",
          code: "I_DO_DISPATCH_FAILURE",
          severity: "infrastructure",
          actionType: action.type,
          errorTag: first?._tag ?? "Defect",
          errorCode: first !== undefined ? codeOf(first) : "E_DEFECT",
          storageReason: first?._tag === "Storage" ? first.reason : undefined,
          storageCause:
            first?._tag === "Storage"
              ? first.cause instanceof Error
                ? first.cause.message
                : String(first.cause)
              : undefined,
        }),
      )
      return Effect.succeed({
        ok: false,
        error: {
          _tag: first?._tag ?? "Defect",
          code: first !== undefined ? codeOf(first) : "E_DEFECT",
        },
      } satisfies QueueResult)
    },
  })
