import { Temporal } from "@js-temporal/polyfill"
import type { TicketId } from "../types/EntityId.js"
import type { BusinessTimeZone } from "../value-objects/BusinessTimeZone.js"
import { type CustomerHandle, equalsCustomerHandle } from "../value-objects/CustomerHandle.js"
import { type Lane, PREFERRED_LANE_CHAIN } from "./Lane.js"
import { intervalOf, type Slot } from "./Slot.js"
import {
  type Called,
  isCalled,
  isPendingNoShow,
  isWaiting,
  type PendingNoShow,
  type Ticket,
  type Waiting,
} from "./Ticket.js"
import type { TicketEvent } from "./TicketEvent.js"

/**
 * Read-model snapshot derived from the append-only ticket-event log
 * (ADR-0051 / ADR-0059). The snapshot is a left-fold over the event
 * sequence — `replay(events) ≡ events.reduce(applyEvent, empty)` —
 * so the queue's "truth" lives in the log, and the snapshot is what
 * downstream projection consumers (the staff dashboard, the customer
 * page, the operator audit) read.
 *
 * Per ADR-0062 the queue is partitioned into lanes (`walkIn /
 * priority / reservation`); per ADR-0065 each ticket carries a
 * per-lane `displaySeq` assigned at Issue time. The derived helpers
 * below read both: `head(snap)` consumes lanes in the preferred-chain
 * order, `headOfLane` consumes a single lane.
 *
 * The replay is a **monoid homomorphism** over the free monoid on
 * events: `replay(xs ++ ys) = applyMany(replay(xs), ys)`. The
 * `homomorphism.test.ts` property test pins this invariant directly.
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
        lane: event.lane,
        displaySeq: event.displaySeq,
        nameKana: event.nameKana,
        phoneLast4: event.phoneLast4,
        freeText: event.freeText,
        issuedAt: event.occurredAt,
        appointmentAt: event.appointmentAt,
        checkedInAt: null,
        state: "Waiting",
      }
      tickets.set(event.ticketId, t)
      return { tickets }
    }
    case "Called": {
      const prior = tickets.get(event.ticketId)
      if (prior?.state !== "Waiting") return snap
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
      if (prior?.state !== "Called") return snap
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
      if (prior === undefined) return snap
      if (prior.state !== "Called" && prior.state !== "PendingNoShow") return snap
      const next: Ticket = {
        ...prior,
        state: "NoShow",
        markedAt: event.occurredAt,
        markedBy: event.markedBy,
      }
      tickets.set(event.ticketId, next)
      return { tickets }
    }
    case "PendingNoShowMarked": {
      const prior = tickets.get(event.ticketId)
      if (prior?.state !== "Called") return snap
      const next: PendingNoShow = {
        ...prior,
        state: "PendingNoShow",
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
    case "Recalled": {
      const prior = tickets.get(event.ticketId)
      if (prior === undefined) return snap
      if (prior.state !== "Called" && prior.state !== "PendingNoShow") return snap
      // Drop the Called-only / PendingNoShow-only fields by
      // reconstructing the common shape verbatim — keeping
      // `seq + displaySeq + lane` is the point (the ticket returns
      // to its lane head), but `calledAt` / `calledBy` /
      // `markedAt` must NOT leak into the Waiting variant.
      const next: Ticket = {
        id: prior.id,
        seq: prior.seq,
        lane: prior.lane,
        displaySeq: prior.displaySeq,
        nameKana: prior.nameKana,
        phoneLast4: prior.phoneLast4,
        freeText: prior.freeText,
        issuedAt: prior.issuedAt,
        appointmentAt: prior.appointmentAt,
        checkedInAt: prior.checkedInAt,
        state: "Waiting",
      }
      tickets.set(event.ticketId, next)
      return { tickets }
    }
    case "CheckedIn": {
      const prior = tickets.get(event.ticketId)
      if (prior?.state !== "Waiting") return snap
      // Idempotent: re-applying CheckedIn keeps the earliest arrival
      // instant. The use case prevents double-fire at the boundary,
      // but the projection is the source of truth for replay.
      if (prior.checkedInAt !== null) return snap
      const next: Waiting = { ...prior, checkedInAt: event.occurredAt }
      tickets.set(event.ticketId, next)
      return { tickets }
    }
    case "Rescheduled": {
      const prior = tickets.get(event.ticketId)
      if (prior === undefined) return snap
      if (
        prior.state !== "Waiting" &&
        prior.state !== "Called" &&
        prior.state !== "PendingNoShow"
      ) {
        return snap
      }
      // Lane invariant: only reservation tickets carry an
      // appointmentAt. Walk-in / priority tickets that somehow reach
      // here are ignored — the usecase already gates on lane.
      if (prior.lane !== "reservation") return snap
      const next: Ticket = { ...prior, appointmentAt: event.toAppointmentAt }
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

/**
 * Lane-filter predicate. `filter === undefined` matches every
 * ticket; otherwise the lane must match exactly. Returning a
 * single boolean keeps coverage tractable (one branch per call
 * site) instead of scattering inline `&& t.lane !== lane`
 * shortcuts that v8 splits into multiple branches.
 */
const matchesLane = (ticketLane: Lane, filter: Lane | undefined): boolean => {
  if (filter === undefined) return true
  return ticketLane === filter
}

/**
 * The Waiting head of the given lane — the ticket with the lowest
 * `displaySeq` among Waiting tickets in that lane. Returns `null`
 * when the lane has no Waiting ticket.
 */
export const headOfLane = (snap: QueueSnapshot, lane: Lane): Waiting | null => {
  let best: Waiting | null = null
  for (const t of snap.tickets.values()) {
    if (!isWaiting(t)) continue
    if (t.lane !== lane) continue
    if (best === null || t.displaySeq < best.displaySeq) best = t
  }
  return best
}

/**
 * The first lane along {@link PREFERRED_LANE_CHAIN} that has a
 * Waiting ticket, or `null` when every lane is empty. The chain is
 * `priority > walkIn > reservation` (ADR-0062).
 *
 * Legacy alias retained for callers that pre-date ADR-0067; new
 * call sites should use {@link firstLaneWithCallable} which adds
 * the time-aware EDF rule for the reservation lane head.
 */
export const firstLaneWithWaiting = (snap: QueueSnapshot): Lane | null => {
  for (const lane of PREFERRED_LANE_CHAIN) {
    if (headOfLane(snap, lane) !== null) return lane
  }
  return null
}

/**
 * Reservation-lane Waiting tickets, sorted by `appointmentAt` asc.
 * Tickets whose `appointmentAt` is null (defensive: should not
 * occur given ADR-0066's `lane === "reservation" ⇔ appointmentAt
 * !== null` invariant) are dropped; the EDF check has nothing to
 * do with them anyway.
 *
 * Used by {@link firstLaneWithCallable} to identify the next
 * deadline candidate, and by the staff Kanban (ADR-0068) to render
 * the per-card slot-time chip in slot order.
 */
export const reservationsByDeadline = (snap: QueueSnapshot): readonly Waiting[] => {
  const candidates: { readonly ticket: Waiting; readonly apptAt: Temporal.Instant }[] = []
  for (const t of snap.tickets.values()) {
    if (!isWaiting(t)) continue
    if (t.lane !== "reservation") continue
    if (t.appointmentAt === null) continue
    candidates.push({ ticket: t, apptAt: t.appointmentAt })
  }
  candidates.sort((a, b) => Temporal.Instant.compare(a.apptAt, b.apptAt))
  return candidates.map((c) => c.ticket)
}

/**
 * ADR-0067 — time-aware lane chain.
 *
 * Returns the first lane whose head is *callable* now: the
 * reservation-lane head with `appointmentAt ≤ now + grace` wins
 * over the static priority chain; otherwise falls through to
 * `priority > walkIn > reservation`. Returns `null` only when the
 * snapshot has no Waiting ticket at all.
 *
 * `grace = 0` and reservation tickets without `appointmentAt`
 * degenerate to {@link firstLaneWithWaiting}.
 */
export const firstLaneWithCallable = (
  snap: QueueSnapshot,
  now: Temporal.Instant,
  grace: Temporal.Duration,
): Lane | null => {
  const reservationHead = reservationsByDeadline(snap)[0]
  if (reservationHead !== undefined && reservationHead.appointmentAt !== null) {
    const cutoff = now.add(grace)
    if (Temporal.Instant.compare(reservationHead.appointmentAt, cutoff) <= 0) {
      return "reservation"
    }
  }
  return firstLaneWithWaiting(snap)
}

/**
 * The next-callable Waiting ticket. Composes
 * {@link firstLaneWithCallable} with the matching head selector:
 * the reservation lane head is the **earliest-`appointmentAt`**
 * Waiting (EDF semantics from ADR-0067), not the lowest
 * `displaySeq` — operators expect the next-deadline reservation,
 * not the order in which reservation tickets were issued.
 *
 * Walk-in / priority lane heads keep ADR-0065's `displaySeq`-min
 * behaviour. Returns `null` when the snapshot has no Waiting ticket.
 */
export const nextCallable = (
  snap: QueueSnapshot,
  now: Temporal.Instant,
  grace: Temporal.Duration,
): Waiting | null => {
  const lane = firstLaneWithCallable(snap, now, grace)
  if (lane === null) return null
  if (lane === "reservation") {
    // `firstLaneWithCallable` only returns "reservation" when
    // `reservationsByDeadline[0]` exists and is within the grace
    // window, so the `?? null` defensive fallback is unreachable
    // here — the v8 coverage tool reports it as a never-taken
    // branch, which we acknowledge.
    /* v8 ignore next */
    return reservationsByDeadline(snap)[0] ?? null
  }
  return headOfLane(snap, lane)
}

/**
 * ADR-0066 — slot capacity bookkeeping.
 *
 * Counts the Waiting / Called / Serving tickets whose
 * `appointmentAt` equals the slot's `startAt` (the canonical
 * bucket boundary in the business time zone). Used by the
 * IssueTicket usecase as the capacity guard before applying the
 * Issued transition: `slotOccupancy(snap, slot, tz) >= slot.capacity`
 * rejects with `SlotFullError`.
 *
 * Cancelled / NoShow / Served / Marked tickets are not counted —
 * those states release the slot.
 */
export const slotOccupancy = (snap: QueueSnapshot, slot: Slot, tz: BusinessTimeZone): number => {
  const { startAt } = intervalOf(slot, tz)
  let n = 0
  for (const t of snap.tickets.values()) {
    if (t.lane !== "reservation") continue
    if (t.appointmentAt === null) continue
    if (!isActiveForHandle(t)) continue
    if (Temporal.Instant.compare(t.appointmentAt, startAt) === 0) n += 1
  }
  return n
}

/**
 * Slot occupancy with one specific ticket virtually removed
 * (ADR-0070). Used by `RescheduleTicket` to check whether the new
 * slot has capacity *after* releasing the ticket's current slot.
 * Without the exclusion a reschedule onto the same slot (or onto
 * one that the ticket already "occupies" from a prior failed
 * write) would always trip the capacity guard.
 *
 * If `excludeTicketId` is not in the snapshot the result equals
 * `slotOccupancy(snap, slot, tz)`.
 */
export const occupancyExcludingSelf = (
  snap: QueueSnapshot,
  excludeTicketId: TicketId,
  slot: Slot,
  tz: BusinessTimeZone,
): number => {
  const { startAt } = intervalOf(slot, tz)
  let n = 0
  for (const t of snap.tickets.values()) {
    if (t.id === excludeTicketId) continue
    if (t.lane !== "reservation") continue
    if (t.appointmentAt === null) continue
    if (!isActiveForHandle(t)) continue
    if (Temporal.Instant.compare(t.appointmentAt, startAt) === 0) n += 1
  }
  return n
}

/**
 * The next ticket to call. When `lane` is supplied returns
 * {@link headOfLane}; otherwise follows the preferred-lane chain
 * and returns the head of the first non-empty lane. Returns `null`
 * when the request lane (or every lane) is empty.
 */
export const head = (snap: QueueSnapshot, lane?: Lane): Waiting | null => {
  if (lane !== undefined) return headOfLane(snap, lane)
  const target = firstLaneWithWaiting(snap)
  if (target === null) return null
  return headOfLane(snap, target)
}

/**
 * The lowest-`displaySeq` Called ticket — the ticket the customer-
 * facing page treats as "currently being called or served" (ADR-0073
 * dropped the explicit Serving variant; the Kanban "対応中" badge is
 * a projection-time hint, not a domain state). Returns `null` when
 * no ticket is in Called.
 */
export const currentlyServing = (snap: QueueSnapshot): Called | null => {
  let best: Called | null = null
  for (const t of snap.tickets.values()) {
    if (!isCalled(t)) continue
    if (best === null || t.displaySeq < best.displaySeq) best = t
  }
  return best
}

/**
 * All tickets in the given lane (or every lane when omitted) that
 * are currently Called, sorted by `displaySeq`.
 */
export const callingTickets = (snap: QueueSnapshot, lane?: Lane): readonly Called[] => {
  const out: Called[] = []
  for (const t of snap.tickets.values()) {
    if (!isCalled(t)) continue
    if (!matchesLane(t.lane, lane)) continue
    out.push(t)
  }
  out.sort((a, b) => a.displaySeq - b.displaySeq)
  return out
}

/**
 * All tickets in PendingNoShow (the grace window opened by staff
 * 「来なかった」 — ADR-0074), sorted by `displaySeq`. The staff
 * Kanban renders these in a dedicated 「催促中」 column with the
 * remaining TTL countdown.
 */
export const pendingNoShowTickets = (
  snap: QueueSnapshot,
  lane?: Lane,
): readonly PendingNoShow[] => {
  const out: PendingNoShow[] = []
  for (const t of snap.tickets.values()) {
    if (!isPendingNoShow(t)) continue
    if (!matchesLane(t.lane, lane)) continue
    out.push(t)
  }
  out.sort((a, b) => a.displaySeq - b.displaySeq)
  return out
}

/**
 * All Waiting tickets in the given lane (or every lane when
 * omitted), sorted by `displaySeq`. The customer-facing position
 * helper and the staff Kanban Waiting column read this directly.
 */
export const waitingTickets = (snap: QueueSnapshot, lane?: Lane): readonly Waiting[] => {
  const out: Waiting[] = []
  for (const t of snap.tickets.values()) {
    if (!isWaiting(t)) continue
    if (!matchesLane(t.lane, lane)) continue
    out.push(t)
  }
  out.sort((a, b) => a.displaySeq - b.displaySeq)
  return out
}

/**
 * Position of `ticketId` **within its lane**: 0 = next-in-lane,
 * 1 = one ahead, etc. Returns `null` if the ticket is not currently
 * Waiting. Cross-lane position (the customer's wait-experience over
 * the preferred chain) is reported by {@link globalPositionOf}.
 */
export const positionOf = (snap: QueueSnapshot, ticketId: TicketId): number | null => {
  const target = snap.tickets.get(ticketId)
  if (target === undefined || !isWaiting(target)) return null
  let ahead = 0
  for (const t of snap.tickets.values()) {
    if (!isWaiting(t)) continue
    if (t.lane !== target.lane) continue
    if (t.displaySeq < target.displaySeq) ahead += 1
  }
  return ahead
}

/**
 * Customer-experience position over the preferred-lane chain
 * (ADR-0062): the count of Waiting tickets in upstream lanes plus
 * the count ahead of `ticketId` in its own lane. Returns `null`
 * when the ticket is not Waiting.
 */
export const globalPositionOf = (snap: QueueSnapshot, ticketId: TicketId): number | null => {
  const target = snap.tickets.get(ticketId)
  if (target === undefined || !isWaiting(target)) return null
  let ahead = 0
  for (const lane of PREFERRED_LANE_CHAIN) {
    if (lane === target.lane) break
    ahead += waitingCount(snap, lane)
  }
  // Lane-internal position: `target` is verified Waiting, so we
  // count peers with smaller displaySeq directly rather than
  // bouncing through positionOf (whose `null` arm is unreachable
  // here and would otherwise leave a dead branch in coverage).
  for (const t of snap.tickets.values()) {
    if (!isWaiting(t)) continue
    if (t.lane !== target.lane) continue
    if (t.displaySeq < target.displaySeq) ahead += 1
  }
  return ahead
}

/** Count of Waiting tickets in the given lane (or globally). */
export const waitingCount = (snap: QueueSnapshot, lane?: Lane): number => {
  let n = 0
  for (const t of snap.tickets.values()) {
    if (!isWaiting(t)) continue
    if (!matchesLane(t.lane, lane)) continue
    n += 1
  }
  return n
}

/**
 * The next-`displaySeq` an Issue should assign within `lane`. The
 * use case computes this off the in-memory projection and embeds it
 * in the `Issued` event payload so the projection can fold it
 * verbatim.
 */
export const nextDisplaySeqInLane = (snap: QueueSnapshot, lane: Lane): number => {
  let max = 0
  for (const t of snap.tickets.values()) {
    if (t.lane !== lane) continue
    if (t.displaySeq > max) max = t.displaySeq
  }
  return max + 1
}

/* -------------------------------------------------------------------------- */
/* Handle-as-active-primary (ADR-0069)                                        */
/* -------------------------------------------------------------------------- */

/**
 * A ticket "holds" the customer's handle while in any of the
 * pre-terminal states (Waiting / Called / PendingNoShow).
 * `CheckedIn` is an audit field on top of `Waiting`, not a state,
 * so it does not appear here. Once a ticket transitions to
 * `Served / Cancelled / NoShow` the handle is released and may be
 * re-used by a fresh issue.
 */
export const isActiveForHandle = (t: Ticket): boolean =>
  t.state === "Waiting" || t.state === "Called" || t.state === "PendingNoShow"

/**
 * `(nameKana, phoneLast4)` is enforced as the **active-set primary key**
 * (ADR-0069). A second issue with the same pair while a prior ticket
 * is still active is an *idempotent merge*: the caller observes the
 * existing ticket instead of minting a new one. The same lookup
 * underpins the customer recovery flow (`GET /tickets/by-handle`),
 * so the two paths share one projection helper.
 *
 * Equality goes through `equalsCustomerHandle` (constant-time per
 * field, ADR-0058) — the iteration order leaks "how many actives
 * precede the match" but not "which kana is in the queue", and the
 * caller is rate-limited (RL_VERIFY, 30/min/IP, ADR-0069 §Trade-offs).
 */
export const findActiveByHandle = (snap: QueueSnapshot, handle: CustomerHandle): Ticket | null => {
  for (const t of snap.tickets.values()) {
    if (!isActiveForHandle(t)) continue
    const stored: CustomerHandle = { nameKana: t.nameKana, phoneLast4: t.phoneLast4 }
    if (!equalsCustomerHandle(stored, handle)) continue
    return t
  }
  return null
}
