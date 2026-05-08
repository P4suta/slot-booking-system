import { Effect } from "effect"
import {
  type ConcurrencyError,
  QueueEmptyError,
  type StorageError,
} from "../../../domain/errors/Errors.js"
import { head, replay } from "../../../domain/queue/projection.js"
import type { Actor, Ticket } from "../../../domain/queue/Ticket.js"
import { applyCallNext } from "../../../domain/queue/transitions.js"
import { Clock } from "../../ports/Clock.js"
import { TicketRepository } from "../../ports/EventSourcedRepository.js"
import { IdGenerator } from "../../ports/IdGenerator.js"
import { Logger } from "../../ports/Logger.js"
import { infoPayload } from "../_log.js"

/**
 * CallNext — pick the lowest-`seq` Waiting ticket and transition it
 * to Called. The use case re-derives the head from a fresh
 * projection over `repo.listAll()` (the in-memory adapter walks the
 * map; the DurableObject adapter Phase 2 issues a single SELECT
 * `seq` ASC, LIMIT 1).
 *
 * Returns the called ticket so the staff dashboard can render the
 * callout immediately. `actor` defaults to `staff`; the no-show
 * sweep alarm passes `system`.
 */
export const CallNext = (
  actor: Actor = "staff",
): Effect.Effect<
  Ticket,
  QueueEmptyError | ConcurrencyError | StorageError,
  Clock | IdGenerator | TicketRepository | Logger
> =>
  Effect.gen(function* () {
    const clock = yield* Clock
    const idgen = yield* IdGenerator
    const repo = yield* TicketRepository
    const logger = yield* Logger
    const all = yield* repo.listAll()
    const snap = replay([])
    // The in-memory adapter does not surface its event log; instead
    // we rebuild the lookup from listAll(), which already projects
    // each row. Construct a synthetic snapshot whose tickets map to
    // the listed states so `head` / `serving` work uniformly.
    const tickets = new Map<string, Ticket>()
    for (const t of all) tickets.set(t.id, t)
    const next = head({ tickets, ...snap })
    if (next === null) return yield* Effect.fail(new QueueEmptyError({}))
    const loaded = yield* repo
      .load(next.id)
      .pipe(
        Effect.catchTag("AggregateNotFound", () =>
          Effect.fail<QueueEmptyError | ConcurrencyError | StorageError>(new QueueEmptyError({})),
        ),
      )
    if (loaded.state.state !== "Waiting") {
      return yield* Effect.fail(new QueueEmptyError({}))
    }
    const eventId = yield* idgen.newTicketEventId
    const at = yield* clock.nowInstant
    const r = applyCallNext(loaded.state, at, eventId, actor)
    if (r._tag === "Failure") return yield* Effect.fail(r.failure)
    yield* repo.save(next.id, loaded.revision, [r.success.event], r.success.ticket)
    yield* logger.info(
      infoPayload("CallNext", "I_USECASE_CALL_NEXT", {
        ticketId: next.id,
        seq: next.seq,
      }),
    )
    return r.success.ticket
  })
