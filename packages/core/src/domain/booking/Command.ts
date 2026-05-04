import type { Temporal } from "@js-temporal/polyfill"
import type { TimeSlot } from "../value-objects/TimeSlot.js"
import type { Actor } from "./Booking.js"

/**
 * Command messages issued against a Booking. Like Booking itself,
 * a discriminated union — the apply function pattern-matches on
 * `command.kind` and the booking's `state` together.
 */
export type Command =
  | { readonly kind: "Confirm"; readonly at: Temporal.Instant }
  | {
      readonly kind: "Cancel"
      readonly at: Temporal.Instant
      readonly reason: string
      readonly by: Actor
    }
  | {
      readonly kind: "Reschedule"
      readonly at: Temporal.Instant
      readonly newSlot: TimeSlot
    }
  | { readonly kind: "Complete"; readonly at: Temporal.Instant }
  | {
      readonly kind: "MarkNoShow"
      readonly at: Temporal.Instant
      readonly by: Actor
    }
  | { readonly kind: "Expire"; readonly at: Temporal.Instant }

export type CommandKind = Command["kind"]
