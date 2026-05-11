import { Temporal } from "@js-temporal/polyfill"
import { Effect } from "effect"
import {
  type ConcurrencyError,
  type DomainError,
  InvalidStateTransitionError,
  LaneMismatchError,
  SlotFullError,
  SlotInPastError,
} from "../../../domain/errors/Errors.js"
import { occupancyExcludingSelf, type QueueSnapshot } from "../../../domain/queue/projection.js"
import { bucketOf, type Slot, type SlotGranularity } from "../../../domain/queue/Slot.js"
import type { Actor, Ticket } from "../../../domain/queue/Ticket.js"
import { applyReschedule } from "../../../domain/queue/transitions.js"
import type { TicketId } from "../../../domain/types/EntityId.js"
import type { BusinessTimeZone } from "../../../domain/value-objects/BusinessTimeZone.js"
import type { CustomerHandle } from "../../../domain/value-objects/CustomerHandle.js"
import { Clock } from "../../ports/Clock.js"
import { TicketRepository } from "../../ports/EventSourcedRepository.js"
import type { IdGenerator } from "../../ports/IdGenerator.js"
import type { Logger } from "../../ports/Logger.js"
import { authenticateCustomer, loadOrTicketNotFound } from "../_authenticate.js"
import { applyAndPersist } from "../_withUseCaseEnv.js"

export type RescheduleTicketInput = {
  readonly ticketId: TicketId
  readonly newAppointmentAt: Temporal.Instant
  readonly granularity: SlotGranularity
  readonly tz: BusinessTimeZone
  readonly capacity: number
  readonly actor: Actor
  readonly handle?: CustomerHandle
}

/**
 * RescheduleTicket — atomic `appointmentAt` swap (ADR-0070).
 *
 * The customer or staff hits `POST /api/v1/tickets/:id/reschedule`
 * with a new `appointmentAt`; the use case moves the ticket onto
 * the new slot in a single transition without releasing the old
 * one in between. Same `ticketId`, `seq`, `displaySeq`, and
 * `handle` — only the booked instant moves.
 *
 * Pre-conditions:
 *
 *   - the ticket exists (TicketNotFound otherwise)
 *   - the ticket is in the **active set**
 *     `{Waiting, Called, PendingNoShow}` (terminal →
 *     AlreadyCancelled / etc. via guardActive)
 *   - the ticket is in the **reservation** lane (LaneMismatch
 *     otherwise; walk-in / priority tickets carry `appointmentAt
 *     === null` by lane invariant)
 *   - `newAppointmentAt >= now` (SlotInPast otherwise)
 *   - the new slot's occupancy *excluding this ticket* is below
 *     capacity (SlotFull otherwise). The "excluding self" carve-out
 *     means a reschedule onto the same slot is always allowed and
 *     no-ops.
 *
 * Customer path (handle supplied) verifies the handle through
 * `authenticateCustomer`; staff path skips it. Same-slot reschedule
 * (= `newAppointmentAt === current`) returns the loaded ticket
 * unchanged without emitting an event.
 */
export const RescheduleTicket = (
  input: RescheduleTicketInput,
): Effect.Effect<
  Ticket,
  DomainError | ConcurrencyError,
  Clock | IdGenerator | TicketRepository | Logger
> =>
  Effect.gen(function* () {
    const repo = yield* TicketRepository
    const clock = yield* Clock
    const loaded =
      input.handle !== undefined
        ? yield* authenticateCustomer(input.ticketId, input.handle)
        : yield* loadOrTicketNotFound(input.ticketId)
    const t = loaded.state
    // Terminal states release the appointmentAt slot; rescheduling
    // a Served / Cancelled / NoShow ticket is meaningless.
    if (t.state === "Served") {
      return yield* Effect.fail(
        new InvalidStateTransitionError({ from: t.state, command: "Reschedule" }),
      )
    }
    if (t.state === "Cancelled" || t.state === "NoShow") {
      return yield* Effect.fail(
        new InvalidStateTransitionError({ from: t.state, command: "Reschedule" }),
      )
    }
    if (t.lane !== "reservation") {
      return yield* Effect.fail(
        new LaneMismatchError({ ticketLane: t.lane, targetLane: "reservation" }),
      )
    }
    /* v8 ignore next 3 */
    if (t.appointmentAt === null) {
      return yield* Effect.fail(
        new InvalidStateTransitionError({ from: t.state, command: "Reschedule" }),
      )
    }
    const now = yield* clock.nowInstant
    // Reject reschedules whose new instant is strictly before now.
    // Slot-grid rounding (bucketOf) makes the practical floor the
    // current bucket's startAt, so customers can still pick the
    // current bucket if it hasn't passed yet.
    if (Temporal.Instant.compare(input.newAppointmentAt, now) < 0) {
      return yield* Effect.fail(
        new SlotInPastError({ appointmentAt: String(input.newAppointmentAt) }),
      )
    }
    // Same-slot reschedule = no-op success. Two callers can race to
    // pick the same target; idempotent return preserves UX without
    // an event log entry.
    if (Temporal.Instant.compare(input.newAppointmentAt, t.appointmentAt) === 0) {
      return t
    }
    // Build the target Slot, then check capacity with this ticket
    // virtually excluded so a reschedule onto a slot the customer
    // already shares (= unlikely but possible under same-bucket
    // alternatives) does not double-count.
    const newBucketId = bucketOf(input.newAppointmentAt, input.tz, input.granularity)
    const newSlot: Slot = {
      date: input.newAppointmentAt.toZonedDateTimeISO(input.tz).toPlainDate(),
      bucketId: newBucketId,
      granularity: input.granularity,
      capacity: input.capacity,
    }
    const all = yield* repo.listAll()
    const snap: QueueSnapshot = {
      tickets: new Map(all.map((tk) => [tk.id, tk] as const)),
    }
    const occupancy = occupancyExcludingSelf(snap, t.id, newSlot, input.tz)
    if (occupancy >= input.capacity) {
      return yield* Effect.fail(
        new SlotFullError({
          date: String(newSlot.date),
          bucketId: newSlot.bucketId,
          granularity: newSlot.granularity,
          capacity: input.capacity,
        }),
      )
    }
    // After the terminal-state and lane guards above, TypeScript has
    // narrowed `t` to `Waiting | Called | PendingNoShow` — exactly
    // what `applyReschedule` accepts.
    const reschedulable = t
    return yield* applyAndPersist({
      loaded,
      apply: (at, eventId) =>
        applyReschedule(reschedulable, input.newAppointmentAt, at, eventId, input.actor),
      log: {
        tag: "RescheduleTicket",
        code: "I_USECASE_RESCHEDULE_TICKET",
        data: { ticketId: input.ticketId, actor: input.actor },
      },
    })
  })
