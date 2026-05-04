import type { Temporal } from "@js-temporal/polyfill"
import type { BookingId, ProviderId, ResourceId, ServiceId } from "../types/EntityId.js"
import type { BookingCode } from "../value-objects/BookingCode.js"
import type { FreeText } from "../value-objects/FreeText.js"
import type { NameKana } from "../value-objects/NameKana.js"
import type { PhoneLast4 } from "../value-objects/PhoneLast4.js"
import type { TimeSlot } from "../value-objects/TimeSlot.js"

/** Where the reservation came from. */
export type BookingSource = "online" | "walkin" | "phone" | "staff"

/** Who initiated a state-changing action. */
export type Actor = "customer" | "staff" | "system"

/** Fields shared by every Booking variant. */
export type BookingCommon = {
  readonly id: BookingId
  readonly code: BookingCode
  readonly serviceId: ServiceId
  readonly providerId: ProviderId
  readonly resourceIds: readonly ResourceId[]
  readonly slot: TimeSlot
  readonly source: BookingSource
  readonly nameKana: NameKana
  readonly phoneLast4: PhoneLast4
  readonly freeText: FreeText | null
}

export type Held = BookingCommon & {
  readonly state: "Held"
  readonly heldAt: Temporal.Instant
  readonly expiresAt: Temporal.Instant
}

export type Confirmed = BookingCommon & {
  readonly state: "Confirmed"
  readonly confirmedAt: Temporal.Instant
}

export type Cancelled = BookingCommon & {
  readonly state: "Cancelled"
  readonly cancelledAt: Temporal.Instant
  readonly reason: string
  readonly cancelledBy: Actor
}

export type Completed = BookingCommon & {
  readonly state: "Completed"
  readonly completedAt: Temporal.Instant
}

export type NoShow = BookingCommon & {
  readonly state: "NoShow"
  readonly markedAt: Temporal.Instant
  readonly markedBy: Actor
}

export type Booking = Held | Confirmed | Cancelled | Completed | NoShow

export type BookingState = Booking["state"]
