import { Effect } from "effect"
import { Clock } from "../ports/Clock.js"
import { TicketRepository } from "../ports/EventSourcedRepository.js"
import { IdGenerator } from "../ports/IdGenerator.js"
import { Logger } from "../ports/Logger.js"

/**
 * Five queue use cases (`IssueTicket`, `CallNext`, `MarkServed`,
 * `MarkNoShow`, `CancelTicket`) all open with the same four-port
 * acquisition. `useCaseEnv` collects them into a record so the
 * use-case body opens with a single destructure rather than four
 * top-of-file `yield*` calls. Reader-monad / applicative-functor
 * pattern: the four `yield*` calls compose under `Effect`'s
 * applicative product.
 */
export const useCaseEnv = Effect.gen(function* () {
  const clock = yield* Clock
  const idgen = yield* IdGenerator
  const repo = yield* TicketRepository
  const logger = yield* Logger
  return { clock, idgen, repo, logger } as const
})
