import { Temporal } from "@js-temporal/polyfill"
import { Effect, Layer } from "effect"
import { Clock } from "../../application/ports/Clock.js"

/**
 * Production wiring of the {@link Clock} port. Each `nowInstant` read
 * delegates to `Temporal.Now.instant()` — the same API the rest of the
 * domain uses for time arithmetic, ensuring no drift between layers.
 */
export const SystemClockLive = Layer.succeed(
  Clock,
  Clock.of({
    nowInstant: Effect.sync(() => Temporal.Now.instant()),
  }),
)
