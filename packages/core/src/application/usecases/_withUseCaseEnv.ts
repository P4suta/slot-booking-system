import type { Temporal } from "@js-temporal/polyfill"
import { Effect } from "effect"
import type { ConcurrencyError, DomainError, StorageError } from "../../domain/errors/Errors.js"
import type { Ticket, TicketState, TicketT } from "../../domain/queue/Ticket.js"
import {
  type ApplyResult,
  guardActive,
  invalidTransition,
  type TicketCommand,
} from "../../domain/queue/transitions.js"
import type { TicketEventId, TicketId } from "../../domain/types/EntityId.js"
import { Clock } from "../ports/Clock.js"
import { type LoadedAggregate, TicketRepository } from "../ports/EventSourcedRepository.js"
import { IdGenerator } from "../ports/IdGenerator.js"
import { Logger } from "../ports/Logger.js"
import { loadOrTicketNotFound } from "./_authenticate.js"
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

/**
 * The Kleisli combinator for tail-identical queue commands —
 * ADR-0080 part 1.
 *
 * `MarkServed` / `MarkPendingNoShow` / `MarkNoShow` / `Recall` /
 * `CallSpecific` (and others further along the train) repeat the
 * same five-line tail:
 *
 *   1. load aggregate by id (`loadOrTicketNotFound`)
 *   2. terminal-state short-circuit (`guardActive` from transitions.ts)
 *   3. source-state narrow (`if state ≠ X → invalidTransition`)
 *   4. capture the narrowed `loaded.state` as the source variant
 *   5. delegate to `applyAndPersist` with the variant-specific
 *      `apply` continuation
 *
 * `runCommand` collapses all five into a single combinator: the
 * caller passes `from` (the accepted source state literal or
 * union) plus the `apply` continuation, and inherits a narrowed
 * `TicketT<S>` argument in `apply`. The runtime check
 * (`from.includes(state)`) is unavoidable — TypeScript can't relate
 * `Array.includes` to type narrowing — but the cast inside the
 * combinator pins the variant exactly once.
 *
 * The combinator is a Kleisli arrow over `Effect`'s `>>=`: it
 * lifts the pure pre-condition predicate (`source ∈ from`) into
 * the effectful command pipeline, leaving the persistence epilogue
 * (`applyAndPersist`) untouched.
 */
export type CommandSpec<S extends TicketState> = {
  readonly ticketId: TicketId
  /** Canonical command name — used both for InvalidStateTransition errors and the audit log tag. */
  readonly command: TicketCommand
  readonly from: S | readonly [S, ...S[]]
  readonly apply: (source: TicketT<S>, at: Temporal.Instant, eventId: TicketEventId) => ApplyResult
  /** Code + data payload — the LogEntry's `tag` is derived from `command`. */
  readonly code: string
  readonly data: Readonly<Record<string, unknown>>
}

export const runCommand = <S extends TicketState>(
  spec: CommandSpec<S>,
): Effect.Effect<
  Ticket,
  DomainError | ConcurrencyError | StorageError,
  Clock | IdGenerator | TicketRepository | Logger
> =>
  Effect.gen(function* () {
    const loaded = yield* loadOrTicketNotFound(spec.ticketId)
    const terminal = guardActive(loaded.state)
    if (terminal !== null) return yield* Effect.fail(terminal)
    const allowed: readonly TicketState[] = (
      Array.isArray(spec.from) ? spec.from : [spec.from]
    ) as readonly TicketState[]
    if (!allowed.includes(loaded.state.state)) {
      return yield* Effect.fail(invalidTransition(loaded.state.state, spec.command))
    }
    const source = loaded.state as TicketT<S>
    return yield* applyAndPersist({
      loaded,
      apply: (at, eventId) => spec.apply(source, at, eventId),
      log: { tag: spec.command, code: spec.code, data: spec.data },
    })
  })
