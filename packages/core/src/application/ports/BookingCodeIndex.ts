import { Context, type Effect } from "effect"
import type { BookingCode } from "../../domain/value-objects/BookingCode.js"

/**
 * Pre-database filter for booking-code lookups (ADR-0014, ADR-0027
 * draft). Production wires this to a Bloom filter built from the
 * current booking set; Phase 0 ships a pessimistic no-op that always
 * answers "yes, possibly". Either way, callers must follow up with a
 * real repository lookup — the index never returns a `Booking`, only
 * a `boolean` filter answer.
 */
export class BookingCodeIndex extends Context.Tag("@booking/core/BookingCodeIndex")<
  BookingCodeIndex,
  {
    readonly mayContain: (code: BookingCode) => Effect.Effect<boolean>
    readonly add: (code: BookingCode) => Effect.Effect<void>
  }
>() {}
