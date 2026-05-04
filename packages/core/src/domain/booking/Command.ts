import type { Temporal } from "@js-temporal/polyfill"
import type { TimeSlot } from "../value-objects/TimeSlot.js"
import type { Actor } from "./Booking.js"

/** Fields shared by every command. The discriminator `kind` plus
 *  command-specific fields are added per variant. */
export type CommandBase = {
  readonly at: Temporal.Instant
}

/**
 * Command messages issued against a Booking. Like Booking itself,
 * a discriminated union — the apply function pattern-matches on
 * `command.kind` and the booking's `state` together.
 */
export type Command =
  | (CommandBase & { readonly kind: "Confirm" })
  | (CommandBase & {
      readonly kind: "Cancel"
      readonly reason: string
      readonly by: Actor
    })
  | (CommandBase & {
      readonly kind: "Reschedule"
      readonly newSlot: TimeSlot
    })
  | (CommandBase & { readonly kind: "Complete" })
  | (CommandBase & { readonly kind: "MarkNoShow"; readonly by: Actor })
  | (CommandBase & { readonly kind: "Expire" })

export type CommandKind = Command["kind"]
