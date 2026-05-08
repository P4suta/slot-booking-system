import { Effect } from "effect"
import {
  type ConcurrencyError,
  type DomainError,
  QueueEmptyError,
  type StorageError,
} from "../../../domain/errors/Errors.js"
import { head } from "../../../domain/queue/projection.js"
import type { Actor, Ticket } from "../../../domain/queue/Ticket.js"
import { applyCallNext } from "../../../domain/queue/transitions.js"
import type { TicketId } from "../../../domain/types/EntityId.js"
import type { Clock } from "../../ports/Clock.js"
import { TicketRepository } from "../../ports/EventSourcedRepository.js"
import type { IdGenerator } from "../../ports/IdGenerator.js"
import type { Logger } from "../../ports/Logger.js"
import { applyAndPersist } from "../_withUseCaseEnv.js"

/**
 * CallNext — pick the lowest-`seq` Waiting ticket and transition it
 * to Called. The use case re-derives the head from a fresh
 * projection over `repo.listAll()` (the in-memory adapter walks the
 * map; the DurableObject adapter issues a single SELECT seq ASC
 * LIMIT 1).
 *
 * Returns the called ticket so the staff dashboard can render the
 * callout immediately. `actor` defaults to `staff`; the no-show
 * sweep alarm passes `system`.
 */
export const CallNext = (
  actor: Actor = "staff",
): Effect.Effect<
  Ticket,
  DomainError | ConcurrencyError | StorageError,
  Clock | IdGenerator | TicketRepository | Logger
> =>
  Effect.gen(function* () {
    const repo = yield* TicketRepository
    const all = yield* repo.listAll()
    // The in-memory adapter does not surface its event log; instead
    // we rebuild the lookup from listAll(), which already projects
    // each row. Construct a synthetic snapshot whose tickets map to
    // the listed states so `head` / `serving` work uniformly.
    const tickets = new Map<TicketId, Ticket>()
    for (const t of all) tickets.set(t.id, t)
    const next = head({ tickets })
    if (next === null) return yield* Effect.fail(new QueueEmptyError({}))
    // `repo.load(next.id)` defensively maps a missing aggregate / a
    // non-Waiting load result to QueueEmpty. Both arms cover a race
    // window only the multi-writer DO can hit (head() saw the row,
    // load() did not / saw it after a transition). The catchTag
    // callback is exercised through a stub repo in the use-case
    // tests; the `state !== Waiting` arm is genuinely unreachable
    // through the InMemory adapter (head() already filtered) so
    // sits behind `v8 ignore` until a DO-level race fixture lands.
    const loaded = yield* repo
      .load(next.id)
      .pipe(
        Effect.catchTag("AggregateNotFound", () =>
          Effect.fail<DomainError>(new QueueEmptyError({})),
        ),
      )
    /* v8 ignore next 3 */
    if (loaded.state.state !== "Waiting") {
      return yield* Effect.fail(new QueueEmptyError({}))
    }
    const waiting = loaded.state
    return yield* applyAndPersist({
      loaded,
      apply: (at, eventId) => applyCallNext(waiting, at, eventId, actor),
      log: {
        tag: "CallNext",
        code: "I_USECASE_CALL_NEXT",
        data: { ticketId: next.id, seq: next.seq },
      },
    })
  })
