import { Effect } from "effect"
import { Clock } from "../ports/Clock.js"
import { BookingEventSourcedRepository } from "../ports/EventSourcedRepository.js"
import { IdGenerator } from "../ports/IdGenerator.js"
import { Logger } from "../ports/Logger.js"

/**
 * Shared booking-flow environment. Five of the use cases (`HoldSlot`,
 * `ConfirmBooking`, `CancelBooking`, `RescheduleBooking`,
 * `ExpireBooking`) need the same four services on entry. Pulling
 * each of them via `yield* SomeService` at the top of every use case
 * is repetitive boilerplate that hides the actual flow.
 *
 * `useCaseEnv` collects the four into a single record-yielding
 * `Effect`, so a use case body opens with
 * `const { clock, idgen, repo, logger } = yield* useCaseEnv` and
 * threads them into the rest of the flow. Reader-monad / applicative-
 * functor pattern: the four `yield*` calls compose under `Effect`'s
 * applicative product, and the sequence is sequenced once at the
 * call-site. The result/requirements types are inferred so future
 * service additions to the bundle propagate automatically.
 */
export const useCaseEnv = Effect.gen(function* () {
  const clock = yield* Clock
  const idgen = yield* IdGenerator
  const repo = yield* BookingEventSourcedRepository
  const logger = yield* Logger
  return { clock, idgen, repo, logger }
})
