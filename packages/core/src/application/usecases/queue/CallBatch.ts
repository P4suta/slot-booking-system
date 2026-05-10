import type { Temporal } from "@js-temporal/polyfill"
import { Effect } from "effect"
import type { ConcurrencyError, DomainError, StorageError } from "../../../domain/errors/Errors.js"
import type { Actor, Ticket } from "../../../domain/queue/Ticket.js"
import { applyCall, guardActive, invalidTransition } from "../../../domain/queue/transitions.js"
import type { BatchId, TicketId } from "../../../domain/types/EntityId.js"
import { Clock } from "../../ports/Clock.js"
import {
  type BatchedSave,
  type NonEmptyReadonlyArray,
  TicketRepository,
} from "../../ports/EventSourcedRepository.js"
import { IdGenerator } from "../../ports/IdGenerator.js"
import { Logger } from "../../ports/Logger.js"
import { loadOrTicketNotFound } from "../_authenticate.js"
import { infoPayload } from "../_log.js"

/**
 * CallBatch — atomically call N Waiting tickets (ADR-0065). Each
 * member emits its own `Called` event sharing a single freshly-
 * minted `BatchId`; the whole batch is persisted in one
 * `repo.saveBatch` transaction so a single mismatched revision
 * rolls every member back. Members that fail any pre-condition
 * (terminal state, non-Waiting source, ticket not found) abort the
 * entire batch — the operator sees the same failure mode whether
 * the bad member was first, last, or in the middle.
 */

type Member = { readonly update: BatchedSave; readonly ticket: Ticket }

const buildMember = (
  id: TicketId,
  at: Temporal.Instant,
  actor: Actor,
  batchId: BatchId,
): Effect.Effect<
  Member,
  DomainError | ConcurrencyError | StorageError,
  IdGenerator | TicketRepository
> =>
  Effect.gen(function* () {
    const idgen = yield* IdGenerator
    const loaded = yield* loadOrTicketNotFound(id)
    const terminal = guardActive(loaded.state)
    if (terminal !== null) return yield* Effect.fail(terminal)
    if (loaded.state.state !== "Waiting") {
      return yield* Effect.fail(invalidTransition(loaded.state.state, "CallBatch"))
    }
    const waiting = loaded.state
    const eventId = yield* idgen.newTicketEventId
    const { ticket, event } = applyCall(waiting, { at, eventId, calledBy: actor, batchId })
    const update: BatchedSave = {
      id: waiting.id,
      expected: loaded.revision,
      events: [event] as const,
      next: ticket,
    }
    return { update, ticket }
  })

export const CallBatch = (
  ticketIds: NonEmptyReadonlyArray<TicketId>,
  actor: Actor = "staff",
): Effect.Effect<
  readonly Ticket[],
  DomainError | ConcurrencyError | StorageError,
  Clock | IdGenerator | TicketRepository | Logger
> =>
  Effect.gen(function* () {
    const idgen = yield* IdGenerator
    const clock = yield* Clock
    const repo = yield* TicketRepository
    const logger = yield* Logger
    const batchId = yield* idgen.newBatchId
    const at = yield* clock.nowInstant
    const [firstId, ...restIds] = ticketIds

    const head = yield* buildMember(firstId, at, actor, batchId)
    const tail: Member[] = []
    for (const id of restIds) {
      const member = yield* buildMember(id, at, actor, batchId)
      tail.push(member)
    }
    const updates: NonEmptyReadonlyArray<BatchedSave> = [
      head.update,
      ...tail.map((m) => m.update),
    ] as const
    const calledTickets: readonly Ticket[] = [head.ticket, ...tail.map((m) => m.ticket)]

    yield* repo.saveBatch(updates)
    yield* logger.info(
      infoPayload("CallBatch", "I_USECASE_CALL_BATCH", {
        batchId,
        ticketIds: ticketIds.slice(),
        count: ticketIds.length,
        actor,
      }),
    )
    return calledTickets
  })
