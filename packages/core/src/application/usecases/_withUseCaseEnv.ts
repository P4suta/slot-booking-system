import type { Temporal } from "@js-temporal/polyfill"
import { Effect } from "effect"
import type { ConcurrencyError, StorageError } from "../../domain/errors/Errors.js"
import type { Ticket } from "../../domain/queue/Ticket.js"
import type { ApplyResult } from "../../domain/queue/transitions.js"
import type { TicketEventId, TicketId } from "../../domain/types/EntityId.js"
import { Clock } from "../ports/Clock.js"
import { type LoadedAggregate, TicketRepository } from "../ports/EventSourcedRepository.js"
import { IdGenerator } from "../ports/IdGenerator.js"
import { Logger } from "../ports/Logger.js"
import { infoPayload } from "./_log.js"

/**
 * Six queue use cases all open with the same four-port acquisition.
 * `useCaseEnv` collects them into a record so call sites that need
 * direct access (tests, future use cases) can destructure once.
 * Reader-monad / applicative-functor pattern: the four `yield*` calls
 * compose under `Effect`'s applicative product.
 */
export const useCaseEnv = Effect.gen(function* () {
  const clock = yield* Clock
  const idgen = yield* IdGenerator
  const repo = yield* TicketRepository
  const logger = yield* Logger
  return { clock, idgen, repo, logger } as const
})

/**
 * Identifier triplet emitted into the audit log alongside successful
 * state transitions. Matches `infoPayload`'s shape (ADR-0009 / ADR-0026).
 */
export type LogEntry = {
  readonly tag: string
  readonly code: string
  readonly data: Readonly<Record<string, unknown>>
}

/**
 * Combinator for the "loaded → apply transition → save with revision
 * check → emit info log" tail shared by `CallNext` / `MarkServed` /
 * `MarkNoShow` / `CancelTicket` / `Recall`. The use-case body keeps
 * its guards and pre-conditions; `applyAndPersist` owns the four-port
 * acquisition plus the `repo.save` + `logger.info` epilogue.
 *
 * The `apply` continuation is intentionally pure — it receives the
 * loaded state, the wall-clock instant, and a freshly-minted event id,
 * and returns the next ticket plus the emitted event. Variant inputs
 * (actor, reason, …) are closed over by the caller so the combinator
 * stays uniform across the five tail-identical use cases.
 */
export const applyAndPersist = ({
  loaded,
  apply,
  log,
}: {
  readonly loaded: LoadedAggregate<Ticket>
  readonly apply: (at: Temporal.Instant, eventId: TicketEventId) => ApplyResult
  readonly log: LogEntry
}): Effect.Effect<
  Ticket,
  ConcurrencyError | StorageError,
  Clock | IdGenerator | TicketRepository | Logger
> =>
  Effect.gen(function* () {
    const clock = yield* Clock
    const idgen = yield* IdGenerator
    const repo = yield* TicketRepository
    const logger = yield* Logger
    const eventId = yield* idgen.newTicketEventId
    const at = yield* clock.nowInstant
    const { ticket, event } = apply(at, eventId)
    yield* repo.save(loaded.state.id, loaded.revision, [event], ticket).pipe(
      Effect.tapError((err) =>
        logger.error({
          _tag: "SaveFailed",
          code: "I_USECASE_SAVE_FAILED",
          severity: "infrastructure",
          data: {
            ticketId: loaded.state.id,
            action: log.tag,
            actor: log.data.actor,
            errorTag: err._tag,
          },
        }),
      ),
    )
    yield* logger.info(infoPayload(log.tag, log.code, log.data))
    return ticket
  })

/**
 * Sibling combinator for `IssueTicket`. Mints a fresh ticket id +
 * monotonic seq, hands them to the pure `apply` continuation, and
 * persists via `repo.issue` (which has no revision precondition since
 * the aggregate is brand new). Shares the same Clock/IdGenerator/Logger
 * acquisition + audit-log epilogue with `applyAndPersist`.
 */
export const issueAndPersist = ({
  apply,
  log,
}: {
  readonly apply: (
    id: TicketId,
    eventId: TicketEventId,
    at: Temporal.Instant,
    seq: number,
  ) => ApplyResult
  readonly log: (out: { readonly id: TicketId; readonly seq: number }) => LogEntry
}): Effect.Effect<
  Ticket,
  ConcurrencyError | StorageError,
  Clock | IdGenerator | TicketRepository | Logger
> =>
  Effect.gen(function* () {
    const clock = yield* Clock
    const idgen = yield* IdGenerator
    const repo = yield* TicketRepository
    const logger = yield* Logger
    const id = yield* idgen.newTicketId
    const eventId = yield* idgen.newTicketEventId
    const seq = yield* repo.nextSeq()
    const at = yield* clock.nowInstant
    const { ticket, event } = apply(id, eventId, at, seq)
    yield* repo.issue(id, [event], ticket)
    const entry = log({ id, seq })
    yield* logger.info(infoPayload(entry.tag, entry.code, entry.data))
    return ticket
  })
