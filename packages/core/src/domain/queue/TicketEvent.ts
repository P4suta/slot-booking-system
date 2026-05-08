import { Schema } from "effect"
import { TicketEventIdSchema, TicketIdSchema } from "../types/EntityId.js"
import { InstantSchema } from "../types/Temporal.js"
import { FreeTextSchema } from "../value-objects/FreeText.js"
import { NameKanaSchema } from "../value-objects/NameKana.js"
import { PhoneLast4Schema } from "../value-objects/PhoneLast4.js"
import { ActorSchema } from "./Ticket.js"

/* -------------------------------------------------------------------------- */
/* Bitemporal base                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Every ticket event carries identity (`id`, `ticketId`), schema version
 * (`version`), and the bitemporal pair (`occurredAt` / `recordedAt`)
 * the slot-graph established under ADR-0032. `occurredAt = recordedAt`
 * for online flows (the use case asks `Clock.nowInstant` once and
 * threads it through both fields); the pair only diverges when a use
 * case back-dates a transition (system-issued no-show sweep).
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
  nameKana: NameKanaSchema,
  phoneLast4: PhoneLast4Schema,
  freeText: Schema.NullOr(FreeTextSchema),
})
export type IssuedEvent = Schema.Schema.Type<typeof IssuedEventSchema>

export const CalledEventSchema = Schema.Struct({
  ...TicketEventBaseFields,
  type: Schema.Literal("Called"),
  calledBy: ActorSchema,
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

/* -------------------------------------------------------------------------- */
/* Top-level union                                                             */
/* -------------------------------------------------------------------------- */

export const TicketEventSchema = Schema.Union([
  IssuedEventSchema,
  CalledEventSchema,
  ServedEventSchema,
  NoShowedEventSchema,
  CancelledEventSchema,
])
export type TicketEvent = Schema.Schema.Type<typeof TicketEventSchema>

export type TicketEventType = TicketEvent["type"]

export const ALL_TICKET_EVENT_TYPES: readonly TicketEventType[] = [
  "Issued",
  "Called",
  "Served",
  "NoShowed",
  "Cancelled",
] as const
