import { Duration } from "../value-objects/Duration.js"
import type { Lane } from "./Lane.js"

/**
 * Queue domain policies — magnitudes and predicates that arbitrate the
 * lifecycle of a single ticket (ADR-0078).
 *
 * This module is the single source of truth for every wall-clock
 * threshold that crosses the core/server/web boundary, plus the
 * EDF-lateness predicate that decides reservation callability.
 *
 * Adding a new magnitude here (rather than as a bare-number constant at
 * the call site) is the way to keep the system's timing coherent —
 * if you change `RESERVATION_GRACE`, every callable-now decision,
 * call-button enable state, and projection partition moves together.
 */
export const Policies = {
  /**
   * EDF grace window before a reservation ticket becomes callable
   * (ADR-0067). Walk-in / priority tickets are always callable; a
   * reservation customer is callable only inside
   * `appointmentAt - RESERVATION_GRACE ≤ now`.
   */
  RESERVATION_GRACE: Duration.minutes("Grace", 5),

  /**
   * Threshold past a ticket's `calledAt` after which staff Kanban
   * presents it under the "対応中" column rather than "呼び出し中"
   * (ADR-0073 — Serving as derived classification).
   */
  SERVING_THRESHOLD: Duration.seconds("ServingThreshold", 30),

  /**
   * PendingNoShow → NoShow auto-sweep TTL (ADR-0074). Override at
   * deploy time via env `GRACE_TTL_MIN`.
   */
  PENDING_NOSHOW_TTL: Duration.minutes("PendingNoShowTtl", 10),

  /**
   * WebSocket broadcast coalesce window (ADR-0075). Dispatches inside
   * a coalesce window collapse to a single delta frame.
   */
  BROADCAST_COALESCE: Duration.ms("BroadcastCoalesce", 100),

  /** WebSocket keepalive interval. */
  WS_KEEPALIVE: Duration.seconds("Keepalive", 30),

  /**
   * /ticket page check-in window — staff and customer share a 10-min
   * countdown leading up to `appointmentAt`.
   */
  CHECK_IN_WINDOW: Duration.minutes("CheckInWindow", 10),

  /** Initial reconnect back-off; doubles each failed attempt up to CAP. */
  RECONNECT_INITIAL: Duration.ms("ReconnectBackoff", 500),
  RECONNECT_CAP: Duration.seconds("ReconnectBackoff", 30),
} as const

/**
 * Minimal shape consumed by {@link isCallableNow}. Any record carrying
 * a `lane` plus a Date-parseable ISO `appointmentAt` (or `null`)
 * qualifies — that covers `EncodedTicket` (SQL row), client-side
 * `Ticket` (wire payload), and core `TicketT<"Waiting">` alike,
 * without each call site needing its own copy of the predicate.
 */
export type IsCallableNowInput = {
  readonly lane: Lane
  readonly appointmentAt: string | null
}

/**
 * EDF-lateness lens — the single source of truth for "is this waiting
 * ticket callable now?".
 *
 * Walk-in / priority tickets bypass the grace check (they have no
 * scheduled appointment time, so EDF lateness is vacuously satisfied).
 * A reservation ticket becomes callable when `appointmentAt - grace ≤
 * now`. Malformed / absent `appointmentAt` fails open (callable) — a
 * defensive landing for legacy rows.
 *
 * The `grace` argument defaults to {@link Policies.RESERVATION_GRACE}
 * so the bulk of call sites are one-arg; integration tests and the
 * env-override path may pass a custom grace.
 */
export const isCallableNow = (
  ticket: IsCallableNowInput,
  nowEpochMs: number,
  grace: Duration<"Grace"> = Policies.RESERVATION_GRACE,
): boolean => {
  if (ticket.lane !== "reservation") return true
  if (ticket.appointmentAt === null) return true
  const atMs = Date.parse(ticket.appointmentAt)
  if (Number.isNaN(atMs)) return true
  return atMs - Duration.toMillis(grace) <= nowEpochMs
}
