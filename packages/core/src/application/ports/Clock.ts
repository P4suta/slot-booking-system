import type { Temporal } from "@js-temporal/polyfill"
import { Context, type Effect } from "effect"

/**
 * Wall-clock side effect, abstracted as an `Effect.Tag`.
 *
 * Production wires {@link Clock} to a `Temporal.Now`-based implementation
 * (`SystemClockLive`); tests wire a deterministic, advanceable clock to
 * remove timing nondeterminism (ADR-0008).
 */
export class Clock extends Context.Tag("@booking/core/Clock")<
  Clock,
  {
    readonly nowInstant: Effect.Effect<Temporal.Instant>
  }
>() {}
