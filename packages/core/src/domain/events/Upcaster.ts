import { Schema } from "effect"
import { type BookingEvent, BookingEventSchema } from "./BookingEvent.js"

/**
 * Event upcasting registry. Phase 0.7-α5 lays the rails: every event
 * variant is currently `version: 1`, so the upcaster chain is empty
 * and `upcastToLatest` is structurally an identity wrapped in
 * `Schema.decodeUnknownSync(BookingEventSchema)`.
 *
 * When a v2 variant lands, register an `Upcaster<V1, V2>` here and
 * the read-path replay (`domain/read/projection.ts` callers) folds
 * old events through it transparently. The decoder check at the end
 * keeps the boundary contract — the latest schema is the only shape
 * that ever reaches `applyEvent`.
 *
 * Generic over `From` / `To` keeps each registered upcaster locally
 * type-safe at its registration site; the chain widens to `unknown`
 * inside the registry because the decoder is the single arbiter of
 * the final shape.
 */
export type Upcaster<From, To> = (event: From) => To

/**
 * Ordered chain of `version N → version N+1` upcasters. Empty today;
 * extending it requires only appending a new entry — no `applyEvent`
 * change.
 */
const upcasterChain: readonly Upcaster<unknown, unknown>[] = []

const decodeBookingEvent = Schema.decodeUnknownSync(BookingEventSchema)

/**
 * Fold an unknown event payload through an explicit `chain` of
 * upcasters and decode the result against the latest
 * {@link BookingEventSchema}. Production callers go through
 * {@link upcastToLatest}; this lower-level entry point exists so
 * tests can inject a chain without the `let`-driven mutation that an
 * in-place stub would require.
 */
export const upcastWith = (
  chain: readonly Upcaster<unknown, unknown>[],
  raw: unknown,
): BookingEvent => {
  let upgraded: unknown = raw
  for (const up of chain) {
    upgraded = up(upgraded)
  }
  return decodeBookingEvent(upgraded)
}

/**
 * Fold an unknown event payload through the registered upcaster
 * chain and decode the result. Throws (via `decodeUnknownSync`) when
 * the resulting shape is not a valid latest-version event — that is
 * the read path's contract: unparsable events block replay rather
 * than silently producing malformed views.
 */
export const upcastToLatest = (raw: unknown): BookingEvent => upcastWith(upcasterChain, raw)
