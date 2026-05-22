import type { CustomerHandle, Lane, NonEmptyReadonlyArray, TicketId } from "@booking/core"

/**
 * The single discriminated union the worker and the QueueShop
 * Durable Object share to encode every state-changing intent.
 *
 * Hoisted out of `QueueShop.ts` so that:
 *
 *   - the router (`http/router.ts`) and the DO instance import
 *     from a single module — no chance the two drift,
 *   - new actions land by editing one file (this one) plus their
 *     boundary schema in `boundarySchemas.ts` and a handler arm
 *     in `queueShop.dispatch`,
 *   - `Effect.Match.discriminator("type")` over `QueueAction`
 *     gets a stable, named home.
 *
 * Every action lands in `QueueShop.dispatch`. The DO RPC boundary
 * structuredClones every arg, which rejects `Temporal.Instant`
 * values — instants travel as ISO-8601 strings and are parsed
 * back through `InstantSchema` inside the dispatch closure.
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
  | { type: "MoveToOverdue"; ticketId: TicketId }
  | { type: "Nudge"; ticketId: TicketId; channel: "ws" | "push" }
  | { type: "LapseAppointment"; ticketId: TicketId }
  | { type: "MarkServed"; ticketId: TicketId }
  | { type: "MarkNoShow"; ticketId: TicketId; actor: "staff" | "system" }
  | { type: "Recall"; ticketId: TicketId; actor: "staff" | "system" }
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
