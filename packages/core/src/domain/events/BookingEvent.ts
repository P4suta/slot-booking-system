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
 * Append-only event emitted on every successful state transition.
 * Distinct events for distinct lifecycle moments (ADR-0013).
 *
 * Events do **not** carry customer PII (`nameKana`, `phoneLast4`,
 * `freeText`) by design: they participate in the long-retention audit
 * trail (ADR-0009) and must outlive PII purge (5y vs 2y).
 */
export type BookingEvent =
  | {
      readonly id: BookingEventId
      readonly type: "Held"
      readonly bookingId: BookingId
      readonly bookingCode: BookingCode
      readonly serviceId: ServiceId
      readonly providerId: ProviderId
      readonly resourceIds: readonly ResourceId[]
      readonly slot: TimeSlot
      readonly at: Temporal.Instant
    }
  | {
      readonly id: BookingEventId
      readonly type: "Confirmed"
      readonly bookingId: BookingId
      readonly at: Temporal.Instant
    }
  | {
      readonly id: BookingEventId
      readonly type: "Cancelled"
      readonly bookingId: BookingId
      readonly at: Temporal.Instant
      readonly reason: string
      readonly by: Actor
    }
  | {
      readonly id: BookingEventId
      readonly type: "Rescheduled"
      readonly bookingId: BookingId
      readonly from: TimeSlot
      readonly to: TimeSlot
      readonly at: Temporal.Instant
    }
  | {
      readonly id: BookingEventId
      readonly type: "Completed"
      readonly bookingId: BookingId
      readonly at: Temporal.Instant
    }
  | {
      readonly id: BookingEventId
      readonly type: "NoShow"
      readonly bookingId: BookingId
      readonly at: Temporal.Instant
      readonly by: Actor
    }

export type BookingEventType = BookingEvent["type"]
