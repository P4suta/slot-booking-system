import type { Temporal } from "@js-temporal/polyfill"
import type { Actor } from "../booking/Booking.js"
import type {
  BookingEventId,
  BookingId,
  ProviderId,
  ResourceId,
  ServiceId,
} from "../types/EntityId.js"
import type { BookingCode } from "../value-objects/BookingCode.js"
import type { TimeSlot } from "../value-objects/TimeSlot.js"

/**
 * Fields shared by every event emitted on a Booking. The discriminator
 * `type` plus event-specific fields are added per variant.
 */
export type BookingEventBase = {
  readonly id: BookingEventId
  readonly bookingId: BookingId
  readonly at: Temporal.Instant
}

/**
 * Append-only event emitted on every successful state transition.
 * Distinct events for distinct lifecycle moments (ADR-0013).
 *
 * Events do **not** carry customer PII (`nameKana`, `phoneLast4`,
 * `freeText`) by design: they participate in the long-retention audit
 * trail (ADR-0009) and must outlive PII purge (5y vs 2y).
 */
export type BookingEvent =
  | (BookingEventBase & {
      readonly type: "Held"
      readonly bookingCode: BookingCode
      readonly serviceId: ServiceId
      readonly providerId: ProviderId
      readonly resourceIds: readonly ResourceId[]
      readonly slot: TimeSlot
    })
  | (BookingEventBase & { readonly type: "Confirmed" })
  | (BookingEventBase & {
      readonly type: "Cancelled"
      readonly reason: string
      readonly by: Actor
    })
  | (BookingEventBase & {
      readonly type: "Rescheduled"
      readonly from: TimeSlot
      readonly to: TimeSlot
    })
  | (BookingEventBase & { readonly type: "Completed" })
  | (BookingEventBase & {
      readonly type: "NoShow"
      readonly by: Actor
    })

export type BookingEventType = BookingEvent["type"]
