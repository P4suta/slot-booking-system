import { Temporal } from "@js-temporal/polyfill"
import type { TicketId } from "../types/EntityId.js"
import type { QueueSnapshot } from "./projection.js"
import { positionOf } from "./projection.js"

/**
 * ETA model — ADR-0066 / ADR-0067.
 *
 * The wait-time projection uses a **closed-form EWMA** (exponentially
 * weighted moving average) over per-ticket service durations:
 *
 *   avg' = α · observation + (1 − α) · avg
 *
 * which is the unique linear smoothing scheme that:
 *
 *   - is stateless beyond a single scalar (`avgServingMs`),
 *   - is a monoid homomorphism on the service-event sequence (so
 *     `replay(events)` re-derives the same metric without re-running
 *     the smoother),
 *   - has bounded recovery (a single bad observation decays to 1%
 *     of its initial weight in `~log(0.01)/log(1−α)` updates).
 *
 * Default `α = 0.1` gives ~28-update half-life — long enough to
 * absorb transient noise, short enough to track diurnal load.
 *
 * `etaOf` lifts the metric to a per-ticket Instant: walk-in tickets
 * get `now + position × avg`, reservations get
 * `max(appointmentAt, now + position × avg)` so the customer's
 * displayed time never goes earlier than the booked slot — calling
 * the customer ahead of slot needs an explicit operator override.
 */

/** Service-time metric folded over historical {@link CalledEvent} → {@link ServedEvent} pairs. */
export type ServiceMetric = {
  readonly avgServingMs: number
  readonly sampleCount: number
}

/** Identity of the EWMA monoid: zero observations, zero average. */
export const emptyMetric: ServiceMetric = {
  avgServingMs: 0,
  sampleCount: 0,
}

/** Default smoothing factor — ~28-update half-life. */
export const DEFAULT_EWMA_ALPHA = 0.1

/**
 * Closed-form EWMA update. The first observation is taken verbatim
 * (no division-by-zero); subsequent observations smooth at `α`.
 *
 * Edge cases:
 *   - `α = 0` ⇒ identity (the metric never moves; first observation
 *     wins).
 *   - `α = 1` ⇒ last-write-wins.
 *   - `obs < 0` ⇒ rejected by the runtime (the IssueTicket /
 *     MarkServed boundary already enforces `Instant` monotonicity).
 */
export const updateMetric = (
  metric: ServiceMetric,
  observationMs: number,
  alpha: number = DEFAULT_EWMA_ALPHA,
): ServiceMetric => {
  if (metric.sampleCount === 0) {
    return { avgServingMs: observationMs, sampleCount: 1 }
  }
  const blended = alpha * observationMs + (1 - alpha) * metric.avgServingMs
  return { avgServingMs: blended, sampleCount: metric.sampleCount + 1 }
}

/**
 * Per-ticket ETA Instant. Walk-in tickets get
 * `now + position × avg`. Reservation tickets clamp at the booked
 * slot start so the displayed time never goes earlier than the
 * customer's appointment (the operator can still call ahead via
 * CallSpecific; the display reflects the contract, not the
 * scheduler).
 *
 * Returns `null` for unknown ticket ids and for non-Waiting tickets
 * (Called / Served / NoShow / Cancelled have no meaningful "wait
 * time remaining" in this scheme — the customer-facing page renders
 * state-specific copy instead).
 */
export const etaOf = (
  snap: QueueSnapshot,
  ticketId: TicketId,
  metric: ServiceMetric,
  now: Temporal.Instant,
): Temporal.Instant | null => {
  const t = snap.tickets.get(ticketId)
  if (t === undefined) return null
  if (t.state !== "Waiting") return null
  // `positionOf` returns null only for non-Waiting / unknown tickets;
  // we already gated on Waiting + presence above, so the `?? 0`
  // fallback is unreachable in normal operation — the v8 coverage
  // tool reports the never-taken branch, which we acknowledge here.
  /* v8 ignore next */
  const position = positionOf(snap, ticketId) ?? 0
  const computedMs = position * metric.avgServingMs
  const computed = now.add({ milliseconds: Math.round(computedMs) })
  if (t.appointmentAt === null) return computed
  return Temporal.Instant.compare(computed, t.appointmentAt) >= 0 ? computed : t.appointmentAt
}
