import { Schema } from "effect"
import { ActorSchema } from "../booking/Booking.js"
import {
  BookingEventIdSchema,
  BookingIdSchema,
  ProviderIdSchema,
  ResourceIdSchema,
  ServiceIdSchema,
} from "../types/EntityId.js"
import { InstantSchema } from "../types/Temporal.js"
import { BookingCodeFromUserInputSchema as BookingCodeBrandSchema } from "../value-objects/BookingCode.js"
import { TimeSlotSchema } from "../value-objects/TimeSlot.js"

/**
 * Fields shared by every event emitted on a Booking. The discriminator
 * `type` plus event-specific fields are added per variant.
 */
const BaseFields = {
  id: BookingEventIdSchema,
  bookingId: BookingIdSchema,
  at: InstantSchema,
} as const

export const HeldEventSchema = Schema.Struct({
  ...BaseFields,
  type: Schema.Literal("Held"),
  bookingCode: BookingCodeBrandSchema,
  serviceId: ServiceIdSchema,
  providerId: ProviderIdSchema,
  resourceIds: Schema.Array(ResourceIdSchema),
  slot: TimeSlotSchema,
})

export const ConfirmedEventSchema = Schema.Struct({
  ...BaseFields,
  type: Schema.Literal("Confirmed"),
})

export const CancelledEventSchema = Schema.Struct({
  ...BaseFields,
  type: Schema.Literal("Cancelled"),
  reason: Schema.String,
  by: ActorSchema,
})

export const RescheduledEventSchema = Schema.Struct({
  ...BaseFields,
  type: Schema.Literal("Rescheduled"),
  from: TimeSlotSchema,
  to: TimeSlotSchema,
})

export const CompletedEventSchema = Schema.Struct({
  ...BaseFields,
  type: Schema.Literal("Completed"),
})

export const NoShowEventSchema = Schema.Struct({
  ...BaseFields,
  type: Schema.Literal("NoShow"),
  by: ActorSchema,
})

/**
 * Append-only event emitted on every successful state transition.
 * Distinct events for distinct lifecycle moments (ADR-0013).
 *
 * Events do **not** carry customer PII (`nameKana`, `phoneLast4`,
 * `freeText`) by design: they participate in the long-retention audit
 * trail (ADR-0009) and must outlive PII purge (5y vs 2y).
 */
export const BookingEventSchema = Schema.Union(
  HeldEventSchema,
  ConfirmedEventSchema,
  CancelledEventSchema,
  RescheduledEventSchema,
  CompletedEventSchema,
  NoShowEventSchema,
)
export type BookingEvent = Schema.Schema.Type<typeof BookingEventSchema>

/** Common-fields helper for projections. */
export type BookingEventBase = Pick<BookingEvent, keyof typeof BaseFields>

export type BookingEventType = BookingEvent["type"]
