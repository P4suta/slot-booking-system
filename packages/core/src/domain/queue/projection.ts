import type { TicketId } from "../types/EntityId.js"
import type { Called, Ticket, Waiting } from "./Ticket.js"
import type { TicketEvent } from "./TicketEvent.js"

/**
 * Read-model snapshot derived from the append-only ticket-event log
 * (ADR-0051 / queue-pivot plan §2.1). The snapshot is a left-fold over
 * the event sequence — `replay(events) ≡ events.reduce(applyEvent, empty)`
 * — so the queue's "truth" lives in the log, and the snapshot is the
 * downstream projection consumers (GraphQL queries, Subscription
 * deltas, the staff dashboard) read.
 *
 * Two derived fields are O(1) to read off the snapshot:
 *
 *   - {@link head}: the next ticket the staff dashboard's "次を呼ぶ"
 *     button targets — the lowest-`seq` `Waiting` ticket.
 *   - {@link serving}: the ticket currently in `Called` state, or
 *     `null` when no one has been called or the previous Called
 *     transitioned to a terminal state.
 *
 * The replay is a **monoid homomorphism** over the free monoid on
 * events: `replay(xs ++ ys) = applyMany(replay(xs), ys)`. The Phase 1
 * property test pins this invariant directly.
 */
export type QueueSnapshot = {
  readonly tickets: ReadonlyMap<TicketId, Ticket>
}

/** Empty snapshot — the fold's identity element. */
export const empty: QueueSnapshot = {
  tickets: new Map<TicketId, Ticket>(),
}

const cloneTickets = (snap: QueueSnapshot): Map<TicketId, Ticket> => new Map(snap.tickets)

/* -------------------------------------------------------------------------- */
/* applyEvent — the per-step transition the fold runs.                         */
/* -------------------------------------------------------------------------- */

export const applyEvent = (snap: QueueSnapshot, event: TicketEvent): QueueSnapshot => {
  const tickets = cloneTickets(snap)
  switch (event.type) {
    case "Issued": {
      const t: Ticket = {
        id: event.ticketId,
        seq: event.seq,
        nameKana: event.nameKana,
        phoneLast4: event.phoneLast4,
        freeText: event.freeText,
        issuedAt: event.occurredAt,
        state: "Waiting",
      }
      tickets.set(event.ticketId, t)
      return { tickets }
    }
    case "Called": {
      const prior = tickets.get(event.ticketId)
      if (prior === undefined || prior.state !== "Waiting") return snap
      const next: Called = {
        ...prior,
        state: "Called",
        calledAt: event.occurredAt,
        calledBy: event.calledBy,
      }
      tickets.set(event.ticketId, next)
      return { tickets }
    }
    case "Served": {
      const prior = tickets.get(event.ticketId)
      if (prior === undefined || prior.state !== "Called") return snap
      const next: Ticket = {
        ...prior,
        state: "Served",
        servedAt: event.occurredAt,
        servedBy: event.servedBy,
      }
      tickets.set(event.ticketId, next)
      return { tickets }
    }
    case "NoShowed": {
      const prior = tickets.get(event.ticketId)
      if (prior === undefined || prior.state !== "Called") return snap
      const next: Ticket = {
        ...prior,
        state: "NoShow",
        markedAt: event.occurredAt,
        markedBy: event.markedBy,
      }
      tickets.set(event.ticketId, next)
      return { tickets }
    }
    case "Cancelled": {
      const prior = tickets.get(event.ticketId)
      if (prior === undefined || prior.state === "Cancelled") return snap
      const next: Ticket = {
        ...prior,
        state: "Cancelled",
        cancelledAt: event.occurredAt,
        cancelledBy: event.cancelledBy,
        reason: event.reason,
      }
      tickets.set(event.ticketId, next)
      return { tickets }
    }
  }
}

/**
 * Replay an event sequence into a snapshot. `replay([])` is `empty`;
 * `replay(events)` is `events.reduce(applyEvent, empty)`. The result
 * is the canonical projection consumers query.
 */
export const replay = (events: readonly TicketEvent[]): QueueSnapshot =>
  events.reduce(applyEvent, empty)

/**
 * Apply a sequence of events to an existing snapshot. The two-arg
 * variant is the monoid action, used by the property test that pins
 * `replay(xs ++ ys) = applyMany(replay(xs), ys)`.
 */
export const applyMany = (snap: QueueSnapshot, events: readonly TicketEvent[]): QueueSnapshot =>
  events.reduce(applyEvent, snap)

/* -------------------------------------------------------------------------- */
/* Derived queries                                                             */
/* -------------------------------------------------------------------------- */

const isWaiting = (t: Ticket): t is Waiting => t.state === "Waiting"
const isCalled = (t: Ticket): t is Called => t.state === "Called"

/**
 * The head of the queue — the lowest-`seq` ticket still in `Waiting`.
 * Returns `null` when no waiting ticket remains.
 */
export const head = (snap: QueueSnapshot): Waiting | null => {
  let best: Waiting | null = null
  for (const t of snap.tickets.values()) {
    if (!isWaiting(t)) continue
    if (best === null || t.seq < best.seq) best = t
  }
  return best
}

/**
 * The currently-serving ticket, or `null` if no one is in `Called`.
 * If multiple tickets are simultaneously `Called` (a bug in single-
 * writer mode but theoretically possible in the projection), the
 * lowest-`seq` one is returned.
 */
export const serving = (snap: QueueSnapshot): Called | null => {
  let best: Called | null = null
  for (const t of snap.tickets.values()) {
    if (!isCalled(t)) continue
    if (best === null || t.seq < best.seq) best = t
  }
  return best
}

/**
 * Position of `ticketId` in the waiting queue: 0 = next to be called,
 * 1 = one ahead, etc. Returns `null` if the ticket is not currently
 * `Waiting`.
 */
export const positionOf = (snap: QueueSnapshot, ticketId: TicketId): number | null => {
  const target = snap.tickets.get(ticketId)
  if (target === undefined || !isWaiting(target)) return null
  let ahead = 0
  for (const t of snap.tickets.values()) {
    if (!isWaiting(t)) continue
    if (t.seq < target.seq) ahead += 1
  }
  return ahead
}

/** Count of tickets currently in `Waiting`. */
export const waitingCount = (snap: QueueSnapshot): number => {
  let n = 0
  for (const t of snap.tickets.values()) if (isWaiting(t)) n += 1
  return n
}
