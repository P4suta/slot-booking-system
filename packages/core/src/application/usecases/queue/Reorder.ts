import { Effect } from "effect"
import {
  type ConcurrencyError,
  type DomainError,
  LaneMismatchError,
  type StorageError,
  TicketNotFoundError,
} from "../../../domain/errors/Errors.js"
import type { Actor, Ticket } from "../../../domain/queue/Ticket.js"
import { applyReorder, guardActive, invalidTransition } from "../../../domain/queue/transitions.js"
import type { TicketId } from "../../../domain/types/EntityId.js"
import type { Clock } from "../../ports/Clock.js"
import { TicketRepository } from "../../ports/EventSourcedRepository.js"
import type { IdGenerator } from "../../ports/IdGenerator.js"
import type { Logger } from "../../ports/Logger.js"
import { loadOrTicketNotFound } from "../_authenticate.js"
import { applyAndPersist } from "../_withUseCaseEnv.js"

/**
 * Reorder — move a Waiting ticket to a new position **within its
 * lane** (ADR-0065). `afterTicketId === null` means "lane head";
 * otherwise the moved ticket sits immediately after the named peer.
 *
 * Cross-lane reorder is forbidden: if `afterTicketId` names a
 * ticket in a different lane the use case fails with
 * {@link LaneMismatchError}, the error class introduced for this
 * exact rule. The projection's lane 内 `displaySeq` rebalance runs
 * on `applyEvent("Reordered")`; this use case is responsible for
 * the boundary check + persistence.
 */
export const Reorder = (
  ticketId: TicketId,
  afterTicketId: TicketId | null,
  actor: Actor = "staff",
): Effect.Effect<
  Ticket,
  DomainError | ConcurrencyError | StorageError,
  Clock | IdGenerator | TicketRepository | Logger
> =>
  Effect.gen(function* () {
    const loaded = yield* loadOrTicketNotFound(ticketId)
    const terminal = guardActive(loaded.state)
    if (terminal !== null) return yield* Effect.fail(terminal)
    if (loaded.state.state !== "Waiting") {
      return yield* Effect.fail(invalidTransition(loaded.state.state, "Reorder"))
    }
    const waiting = loaded.state
    if (afterTicketId !== null) {
      const repo = yield* TicketRepository
      const target = yield* repo
        .load(afterTicketId)
        .pipe(
          Effect.catchTag("AggregateNotFound", () =>
            Effect.fail<DomainError>(new TicketNotFoundError({})),
          ),
        )
      if (target.state.lane !== waiting.lane) {
        return yield* Effect.fail(
          new LaneMismatchError({
            ticketLane: waiting.lane,
            targetLane: target.state.lane,
          }),
        )
      }
    }
    return yield* applyAndPersist({
      loaded,
      apply: (at, eventId) =>
        applyReorder(waiting, { afterTicketId, at, eventId, reorderedBy: actor }),
      log: {
        tag: "Reorder",
        code: "I_USECASE_REORDER",
        data: { ticketId, afterTicketId, lane: waiting.lane },
      },
    })
  })
