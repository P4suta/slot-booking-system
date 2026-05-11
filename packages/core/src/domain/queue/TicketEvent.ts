import { Schema } from "effect"
import { BatchIdSchema, TicketEventIdSchema, TicketIdSchema } from "../types/EntityId.js"
import { InstantSchema } from "../types/Temporal.js"
import { FreeTextSchema } from "../value-objects/FreeText.js"
import { NameKanaSchema } from "../value-objects/NameKana.js"
import { PhoneLast4Schema } from "../value-objects/PhoneLast4.js"
import { LaneSchema } from "./Lane.js"
import { ActorSchema } from "./Ticket.js"

/* -------------------------------------------------------------------------- */
/* Bitemporal base                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Every ticket event carries identity (`id`, `ticketId`), schema
 * version, and the bitemporal pair (`occurredAt` / `recordedAt`)
 * established under ADR-0032 / ADR-0051. `occurredAt = recordedAt`
 * for online flows; the pair only diverges when a use case back-
 * dates a transition (e.g. the system-issued no-show sweep).
 */
const TicketEventBaseFields = {
  id: TicketEventIdSchema,
  ticketId: TicketIdSchema,
  version: Schema.Literal(1),
  occurredAt: InstantSchema,
  recordedAt: InstantSchema,
} as const

/* -------------------------------------------------------------------------- */
/* Event variants                                                              */
/* -------------------------------------------------------------------------- */

export const IssuedEventSchema = Schema.Struct({
  ...TicketEventBaseFields,
  type: Schema.Literal("Issued"),
  seq: Schema.Number,
  lane: LaneSchema,
  displaySeq: Schema.Number,
  nameKana: NameKanaSchema,
  phoneLast4: PhoneLast4Schema,
  freeText: Schema.NullOr(FreeTextSchema),
  appointmentAt: Schema.NullOr(InstantSchema),
})
export type IssuedEvent = Schema.Schema.Type<typeof IssuedEventSchema>

/**
 * `batchId` is set when the event was emitted as part of a
 * `CallBatch` action (ADR-0065): every member of the batch shares a
 * single freshly-minted `BatchId`, recoverable from the audit log
 * via `events.filter(e => e.type === "Called" && e.batchId === b)`.
 * Absent on `CallNext` and `CallSpecific`.
 */
export const CalledEventSchema = Schema.Struct({
  ...TicketEventBaseFields,
  type: Schema.Literal("Called"),
  calledBy: ActorSchema,
  batchId: Schema.optional(BatchIdSchema),
})
export type CalledEvent = Schema.Schema.Type<typeof CalledEventSchema>

export const ServedEventSchema = Schema.Struct({
  ...TicketEventBaseFields,
  type: Schema.Literal("Served"),
  servedBy: ActorSchema,
})
export type ServedEvent = Schema.Schema.Type<typeof ServedEventSchema>

export const NoShowedEventSchema = Schema.Struct({
  ...TicketEventBaseFields,
  type: Schema.Literal("NoShowed"),
  markedBy: ActorSchema,
})
export type NoShowedEvent = Schema.Schema.Type<typeof NoShowedEventSchema>

export const CancelledEventSchema = Schema.Struct({
  ...TicketEventBaseFields,
  type: Schema.Literal("Cancelled"),
  cancelledBy: ActorSchema,
  reason: Schema.String,
})
export type CancelledEvent = Schema.Schema.Type<typeof CancelledEventSchema>

/**
 * Staff withdrew a {@link CalledEvent}: the customer was called by
 * mistake and the ticket should be returned to the head of the
 * waiting queue (its `seq` is preserved by the projection so the
 * lattice's lowest-seq invariant is maintained). Distinct from
 * {@link CancelledEvent} — the ticket is still active and will be
 * re-called; the audit trail keeps both the original `Called` and
 * its `Recalled` so "なかったことに" never erases history.
 */
export const RecalledEventSchema = Schema.Struct({
  ...TicketEventBaseFields,
  type: Schema.Literal("Recalled"),
  recalledBy: ActorSchema,
})
export type RecalledEvent = Schema.Schema.Type<typeof RecalledEventSchema>

/**
 * Customer-issued check-in for a reservation ticket (ADR-0068).
 * Fired when the customer hits the 「到着しました」 button on
 * `/ticket` after `now ≥ appointmentAt - 10min`. The transition is
 * `Waiting → Waiting`; the ticket gains `checkedInAt` so the audit /
 * no-show analytics layer can compare arrival vs. call-time without
 * a separate aggregate.
 */
export const CheckedInEventSchema = Schema.Struct({
  ...TicketEventBaseFields,
  type: Schema.Literal("CheckedIn"),
  checkedInBy: ActorSchema,
})
export type CheckedInEvent = Schema.Schema.Type<typeof CheckedInEventSchema>

/**
 * Reservation reschedule — `appointmentAt` atomic swap (ADR-0070).
 * Same ticketId / seq / handle; only the booked slot moves. Fired
 * when the customer or staff issues
 * `POST /api/v1/tickets/:id/reschedule`. The projection updates the
 * Ticket's `appointmentAt` in place and (transitively) the slot
 * occupancy on both the old and the new slot.
 *
 * Allowed on `state ∈ {Waiting, Called}` and `lane ===
 * "reservation"`; walk-in / priority tickets carry `appointmentAt
 * === null` by lane invariant and are not rescheduleable. The
 * audit-log keeps both `from` and `to` so a no-show analysis can
 * follow the customer's slot history without joining external
 * tables.
 */
export const RescheduledEventSchema = Schema.Struct({
  ...TicketEventBaseFields,
  type: Schema.Literal("Rescheduled"),
  fromAppointmentAt: InstantSchema,
  toAppointmentAt: InstantSchema,
  rescheduledBy: ActorSchema,
})
export type RescheduledEvent = Schema.Schema.Type<typeof RescheduledEventSchema>

/* -------------------------------------------------------------------------- */
/* Top-level union                                                             */
/* -------------------------------------------------------------------------- */

export const TicketEventSchema = Schema.Union([
  IssuedEventSchema,
  CalledEventSchema,
  ServedEventSchema,
  NoShowedEventSchema,
  CancelledEventSchema,
  RecalledEventSchema,
  CheckedInEventSchema,
  RescheduledEventSchema,
])
export type TicketEvent = Schema.Schema.Type<typeof TicketEventSchema>

export type TicketEventType = TicketEvent["type"]

export const ALL_TICKET_EVENT_TYPES: readonly TicketEventType[] = [
  "Issued",
  "Called",
  "Served",
  "NoShowed",
  "Cancelled",
  "Recalled",
  "CheckedIn",
  "Rescheduled",
] as const
