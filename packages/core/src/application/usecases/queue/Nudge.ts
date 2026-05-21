import { Effect } from "effect"
import type { ConcurrencyError, DomainError, StorageError } from "../../../domain/errors/Errors.js"
import type { Ticket } from "../../../domain/queue/Ticket.js"
import { applyNudge, guardActive, invalidTransition } from "../../../domain/queue/transitions.js"
import type { TicketId } from "../../../domain/types/EntityId.js"
import type { Clock } from "../../ports/Clock.js"
import type { TicketRepository } from "../../ports/EventSourcedRepository.js"
import type { IdGenerator } from "../../ports/IdGenerator.js"
import type { Logger } from "../../ports/Logger.js"
import { loadOrTicketNotFound } from "../_authenticate.js"
import { applyAndPersist } from "../_withUseCaseEnv.js"

/**
 * Nudge — `Overdue → Overdue` (ADR-0072), incrementing `nudgeCount`
 * and stamping `lastNudgedAt`. Side-effect-bearing emission of the
 * customer notification is the responsibility of the dispatcher that
 * calls this use case; the use case itself just records the audit
 * event. `channel` records the transport used — `"ws"` for the
 * WebSocket broadcast fallback, `"push"` for Web Push (ADR-0073).
 *
 * Idempotency: the alarm sweep should not invoke `Nudge` more
 * frequently than `NUDGE_INTERVAL_SECONDS`; the dispatcher checks
 * `now - lastNudgedAt > interval` before calling this. A stale call
 * still succeeds (increments the counter); the cadence guard is in
 * the alarm, not here.
 */
export const Nudge = (
  ticketId: TicketId,
  channel: "ws" | "push",
): Effect.Effect<
  Ticket,
  DomainError | ConcurrencyError | StorageError,
  Clock | IdGenerator | TicketRepository | Logger
> =>
  Effect.gen(function* () {
    const loaded = yield* loadOrTicketNotFound(ticketId)
    const terminal = guardActive(loaded.state)
    if (terminal !== null) return yield* Effect.fail(terminal)
    if (loaded.state.state !== "Overdue") {
      return yield* Effect.fail(invalidTransition(loaded.state.state, "Nudge"))
    }
    const overdue = loaded.state
    return yield* applyAndPersist({
      loaded,
      apply: (at, eventId) => applyNudge(overdue, at, eventId, channel, "system"),
      log: {
        tag: "Nudge",
        code: "I_USECASE_NUDGE",
        data: { ticketId, channel },
      },
    })
  })
