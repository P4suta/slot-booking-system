import { Temporal } from "@js-temporal/polyfill"
import { Effect } from "effect"
import {
  type ConcurrencyError,
  type DomainError,
  QueueEmptyError,
  type StorageError,
} from "../../../domain/errors/Errors.js"
import type { Lane } from "../../../domain/queue/Lane.js"
import { head, nextCallable } from "../../../domain/queue/projection.js"
import type { Actor, Ticket } from "../../../domain/queue/Ticket.js"
import { applyCall } from "../../../domain/queue/transitions.js"
import type { TicketId } from "../../../domain/types/EntityId.js"
import { Clock } from "../../ports/Clock.js"
import { TicketRepository } from "../../ports/EventSourcedRepository.js"
import type { IdGenerator } from "../../ports/IdGenerator.js"
import type { Logger } from "../../ports/Logger.js"
import { applyAndPersist } from "../_withUseCaseEnv.js"

/** ADR-0067 EDF grace window — promote a reservation when its
 *  appointmentAt is within `now + grace`. */
const DEFAULT_GRACE_MINUTES = 5

/**
 * CallNext — pick the head of the named lane (or the first non-empty
 * lane along the preferred-lane chain when `lane` is omitted) and
 * transition it to Called. The use case re-derives the head from a
 * fresh projection over `repo.listAll()` (the in-memory adapter walks
 * the map; the DurableObject adapter issues an indexed scan).
 *
 * Returns the called ticket so the staff dashboard can render the
 * callout immediately. `actor` defaults to `staff`; the no-show
 * sweep alarm passes `system`.
 */
export const CallNext = (
  lane?: Lane,
  actor: Actor = "staff",
): Effect.Effect<
  Ticket,
  DomainError | ConcurrencyError | StorageError,
  Clock | IdGenerator | TicketRepository | Logger
> =>
  Effect.gen(function* () {
    const repo = yield* TicketRepository
    const clock = yield* Clock
    const all = yield* repo.listAll()
    const tickets = new Map<TicketId, Ticket>()
    for (const t of all) tickets.set(t.id, t)
    // When the operator names a lane, head-of-lane wins (ADR-0062 +
    // ADR-0065 displaySeq order). When the lane is omitted, EDF +
    // chain selection picks the next callable: a reservation whose
    // appointmentAt ≤ now+grace pre-empts the priority>walkIn>reservation
    // chain (ADR-0067).
    const grace = Temporal.Duration.from({ minutes: DEFAULT_GRACE_MINUTES })
    const now = yield* clock.nowInstant
    const next =
      lane !== undefined ? head({ tickets }, lane) : nextCallable({ tickets }, now, grace)
    if (next === null) return yield* Effect.fail(new QueueEmptyError({}))
    // `repo.load(next.id)` defensively maps a missing aggregate / a
    // non-Waiting load result to QueueEmpty. Both arms cover a race
    // window only the multi-writer DO can hit (head() saw the row,
    // load() did not / saw it after a transition).
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
      apply: (at, eventId) => applyCall(waiting, { at, eventId, calledBy: actor }),
      log: {
        tag: "CallNext",
        code: "I_USECASE_CALL_NEXT",
        data: { ticketId: next.id, seq: next.seq, lane: waiting.lane },
      },
    })
  })
