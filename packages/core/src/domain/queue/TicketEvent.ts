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

/**
 * Operator-grade `Called → Serving` transition (ADR-0063). Marks
 * the moment the customer reached the counter; the NoShow alarm
 * sweep no longer applies past this point.
 */
export const ServingStartedEventSchema = Schema.Struct({
  ...TicketEventBaseFields,
  type: Schema.Literal("ServingStarted"),
  servingStartedBy: ActorSchema,
})
export type ServingStartedEvent = Schema.Schema.Type<typeof ServingStartedEventSchema>

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
 * Operator moved a `Waiting` ticket to a new position within its
 * lane (ADR-0065). `afterTicketId === null` means "lane head";
 * otherwise the target sits immediately after the named ticket.
 * The projection rebalances lane 内 displaySeq to a contiguous
 * `1..N` after applying the event.
 */
export const ReorderedEventSchema = Schema.Struct({
  ...TicketEventBaseFields,
  type: Schema.Literal("Reordered"),
  afterTicketId: Schema.NullOr(TicketIdSchema),
  reorderedBy: ActorSchema,
})
export type ReorderedEvent = Schema.Schema.Type<typeof ReorderedEventSchema>

/* -------------------------------------------------------------------------- */
/* Top-level union                                                             */
/* -------------------------------------------------------------------------- */

export const TicketEventSchema = Schema.Union([
  IssuedEventSchema,
  CalledEventSchema,
  ServingStartedEventSchema,
  ServedEventSchema,
  NoShowedEventSchema,
  CancelledEventSchema,
  RecalledEventSchema,
  ReorderedEventSchema,
])
export type TicketEvent = Schema.Schema.Type<typeof TicketEventSchema>

export type TicketEventType = TicketEvent["type"]

export const ALL_TICKET_EVENT_TYPES: readonly TicketEventType[] = [
  "Issued",
  "Called",
  "ServingStarted",
  "Served",
  "NoShowed",
  "Cancelled",
  "Recalled",
  "Reordered",
] as const
