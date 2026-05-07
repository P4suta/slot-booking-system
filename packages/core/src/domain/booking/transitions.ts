import type { Temporal } from "@js-temporal/polyfill"
import { Match, Result } from "effect"
import { type Capability, hasScope, type StaffScope, subjectOf } from "../auth/Capability.js"
import {
  AlreadyCancelledError,
  AlreadyCompletedError,
  AlreadyNoShowError,
  type DomainError,
  InsufficientCapabilityError,
  InvalidStateTransitionError,
} from "../errors/Errors.js"
import type { BookingEvent } from "../events/BookingEvent.js"
import type { BookingEventId, BookingId } from "../types/EntityId.js"
import type {
  Booking,
  BookingCommon,
  BookingState,
  BookingT,
  Cancelled,
  Completed,
  Confirmed,
  Held,
  NoShow,
} from "./Booking.js"
import type { Command } from "./Command.js"
import type { AllowedCommandKinds, BookingMachineState, NextState } from "./machine.js"

export type ApplyResult = {
  readonly booking: Booking
  readonly event: BookingEvent
}

const common = (b: BookingCommon): BookingCommon => ({
  id: b.id,
  code: b.code,
  serviceId: b.serviceId,
  providerId: b.providerId,
  resourceIds: b.resourceIds,
  slot: b.slot,
  source: b.source,
  nameKana: b.nameKana,
  phoneLast4: b.phoneLast4,
  freeText: b.freeText,
})

/* -------------------------------------------------------------------------- */
/* Right-side smart constructors — the "data declaration" half of each       */
/* (state, command) row. Each returns the next booking + its event in lockstep.*/
/* -------------------------------------------------------------------------- */

const ok = (booking: Booking, event: BookingEvent): Result.Result<ApplyResult, DomainError> =>
  Result.succeed({ booking, event })

/**
 * Bitemporal base for a freshly-emitted event. `occurredAt = recordedAt`
 * for online flows (`apply` is called with `Clock.nowInstant`); the
 * fields diverge only when a higher-level use case decides to back-date
 * a transition (Phase 1.x). Legacy `at` mirror keeps old readers
 * working until they migrate to the explicit pair.
 */
const baseEvent = (id: BookingEventId, bookingId: BookingId, at: Temporal.Instant) =>
  ({
    id,
    bookingId,
    version: 1 as const,
    occurredAt: at,
    recordedAt: at,
  }) as const

const okConfirm = (held: Held, at: Command["at"], eventId: BookingEventId) => {
  const next: Confirmed = { ...common(held), state: "Confirmed", confirmedAt: at }
  const event: BookingEvent = {
    ...baseEvent(eventId, held.id, at),
    type: "Confirmed",
  }
  return ok(next, event)
}

const okCancel = (
  source: Held | Confirmed,
  at: Command["at"],
  reason: string,
  by: Cancelled["cancelledBy"],
  eventId: BookingEventId,
) => {
  const next: Cancelled = {
    ...common(source),
    state: "Cancelled",
    cancelledAt: at,
    reason,
    cancelledBy: by,
  }
  const event: BookingEvent = {
    ...baseEvent(eventId, source.id, at),
    type: "Cancelled",
    reason,
    by,
  }
  return ok(next, event)
}

const okReschedule = (
  confirmed: Confirmed,
  at: Command["at"],
  newSlot: Confirmed["slot"],
  eventId: BookingEventId,
) => {
  const next: Confirmed = {
    ...common(confirmed),
    slot: newSlot,
    state: "Confirmed",
    confirmedAt: confirmed.confirmedAt,
  }
  const event: BookingEvent = {
    ...baseEvent(eventId, confirmed.id, at),
    type: "Rescheduled",
    from: confirmed.slot,
    to: newSlot,
  }
  return ok(next, event)
}

const okComplete = (confirmed: Confirmed, at: Command["at"], eventId: BookingEventId) => {
  const next: Completed = { ...common(confirmed), state: "Completed", completedAt: at }
  const event: BookingEvent = {
    ...baseEvent(eventId, confirmed.id, at),
    type: "Completed",
  }
  return ok(next, event)
}

const okNoShow = (
  confirmed: Confirmed,
  at: Command["at"],
  by: NoShow["markedBy"],
  eventId: BookingEventId,
) => {
  const next: NoShow = { ...common(confirmed), state: "NoShow", markedAt: at, markedBy: by }
  const event: BookingEvent = {
    ...baseEvent(eventId, confirmed.id, at),
    type: "NoShow",
    by,
  }
  return ok(next, event)
}

const invalid = (
  from: Booking["state"],
  kind: Command["kind"],
): Result.Result<ApplyResult, DomainError> =>
  Result.fail(new InvalidStateTransitionError({ from, command: kind }))

/**
 * Scope-membership check for staff-issued commands. Customer and
 * System capabilities pass through (their schema-level filter at the
 * Command boundary already restricted the variants they may issue).
 * Returns `Result.fail(InsufficientCapability)` only when a Staff
 * capability lacks the required scope.
 */
const requireScope = (
  cap: Capability,
  scope: StaffScope,
): Result.Result<void, InsufficientCapabilityError> => {
  if (cap._tag !== "StaffCapability") return Result.succeed(undefined)
  return hasScope(cap, scope)
    ? Result.succeed(undefined)
    : Result.fail(new InsufficientCapabilityError({ required: scope, capability: cap._tag }))
}

/* -------------------------------------------------------------------------- */
/* Per-state dispatch via Match.type / Match.discriminator                     */
/* -------------------------------------------------------------------------- */

const dispatchHeld = (held: Held, eventId: BookingEventId) =>
  Match.type<Command>().pipe(
    Match.discriminator("kind")("Confirm", (cmd) => okConfirm(held, cmd.at, eventId)),
    Match.discriminator("kind")("Cancel", (cmd) =>
      Result.flatMap(requireScope(cmd.capability, "cancel"), () =>
        okCancel(held, cmd.at, cmd.reason, subjectOf(cmd.capability), eventId),
      ),
    ),
    Match.discriminator("kind")("Expire", (cmd) =>
      okCancel(held, cmd.at, "hold expired", subjectOf(cmd.capability), eventId),
    ),
    Match.discriminator("kind")("Reschedule", () => invalid("Held", "Reschedule")),
    Match.discriminator("kind")("Complete", () => invalid("Held", "Complete")),
    Match.discriminator("kind")("MarkNoShow", () => invalid("Held", "MarkNoShow")),
    Match.exhaustive,
  )

const dispatchConfirmed = (confirmed: Confirmed, eventId: BookingEventId) =>
  Match.type<Command>().pipe(
    Match.discriminator("kind")("Cancel", (cmd) =>
      Result.flatMap(requireScope(cmd.capability, "cancel"), () =>
        okCancel(confirmed, cmd.at, cmd.reason, subjectOf(cmd.capability), eventId),
      ),
    ),
    Match.discriminator("kind")("Reschedule", (cmd) =>
      Result.flatMap(requireScope(cmd.capability, "reschedule"), () =>
        okReschedule(confirmed, cmd.at, cmd.newSlot, eventId),
      ),
    ),
    Match.discriminator("kind")("Complete", (cmd) =>
      Result.flatMap(requireScope(cmd.capability, "complete"), () =>
        okComplete(confirmed, cmd.at, eventId),
      ),
    ),
    Match.discriminator("kind")("MarkNoShow", (cmd) =>
      Result.flatMap(requireScope(cmd.capability, "noshow"), () =>
        okNoShow(confirmed, cmd.at, subjectOf(cmd.capability), eventId),
      ),
    ),
    Match.discriminator("kind")("Confirm", () => invalid("Confirmed", "Confirm")),
    Match.discriminator("kind")("Expire", () => invalid("Confirmed", "Expire")),
    Match.exhaustive,
  )

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Total state-transition function. `Match.value` over the booking's state
 * dispatches into a per-state `Match` over the command discriminator; every
 * reachable `(state, command)` pair is handled, and unreachable pairs return
 * `InvalidStateTransition` rather than throwing (ADR-0010, ADR-0013).
 *
 * Exhaustiveness is enforced at compile time by `Match.exhaustive` on both
 * the outer (state) and inner (command kind) dispatchers.
 *
 * Capability discipline (Phase 0.7-β1): every state-changing command
 * carries a `capability` field. The Command schema enforces who may
 * issue what at the boundary (Customer cannot issue `Complete`, etc.);
 * `requireScope` does the residual scope-membership check inside the
 * Staff arm. The actor literal recorded in `Cancelled.cancelledBy` /
 * `NoShow.markedBy` / `Cancelled` events is derived via
 * `subjectOf(capability)` so the audit field has a single source of
 * truth.
 *
 * `newEventId` is injected so callers can run with a deterministic
 * `IdGenerator` port in tests.
 */
export const apply = (
  booking: Booking,
  command: Command,
  newEventId: BookingEventId,
): Result.Result<ApplyResult, DomainError> =>
  Match.value(booking).pipe(
    Match.discriminator("state")("Held", (b) => dispatchHeld(b, newEventId)(command)),
    Match.discriminator("state")("Confirmed", (b) => dispatchConfirmed(b, newEventId)(command)),
    Match.discriminator("state")("Cancelled", () => Result.fail(new AlreadyCancelledError({}))),
    Match.discriminator("state")("Completed", () => Result.fail(new AlreadyCompletedError({}))),
    Match.discriminator("state")("NoShow", () => Result.fail(new AlreadyNoShowError({}))),
    Match.exhaustive,
  )

/* -------------------------------------------------------------------------- */
/* Indexed-monad / typestate variant — Phase 2.0 / BI-1                        */
/* -------------------------------------------------------------------------- */

/**
 * Successful payload of {@link applyTyped}. The `booking` field is
 * narrowed to `BookingT<NextState<S, K>>` — the successor state of
 * `S` under command `K` according to the type-level
 * {@link TransitionTable}.
 */
export type TypedApplyResult<S extends BookingMachineState, K extends AllowedCommandKinds<S>> = {
  readonly booking: BookingT<NextState<S, K>>
  readonly event: BookingEvent
}

/**
 * Indexed-monad / typestate variant of {@link apply}. The (state,
 * command) pair is constrained at the type level via
 * `BookingT<S>` × `Command & { kind: AllowedCommandKinds<S> }`, so an
 * illegal call site (e.g. issuing `Complete` on a `Held`) becomes a
 * compile-time error rather than a runtime
 * `InvalidStateTransitionError` left. Terminal states (`Cancelled` /
 * `Completed` / `NoShow`) have `AllowedCommandKinds<S> = never`, which
 * makes them statically unable to receive any command.
 *
 * The runtime body is `apply` itself; the success-side narrowing to
 * `BookingT<NextState<S, K>>` is justified by the
 * {@link TransitionTable} adjacency invariant cross-validated in
 * `machine.test.ts` — the type-level table and the runtime spec are
 * isomorphic, so a `Right` of `apply(booking, command, _)` whose state
 * is `S` and command kind is `K extends AllowedCommandKinds<S>` is
 * provably in state `NextState<S, K>`.
 *
 * Failure side stays `DomainError` because capability scope checks
 * (`InsufficientCapability`) and aggregate invariants
 * (`SlotExpired` once Phase 0.10 hold semantics land) are runtime
 * concerns the type system cannot enforce.
 */
export const applyTyped = <S extends BookingMachineState, K extends AllowedCommandKinds<S>>(
  booking: BookingT<S>,
  command: Command & { kind: K },
  newEventId: BookingEventId,
): Result.Result<TypedApplyResult<S, K>, DomainError> =>
  apply(booking, command, newEventId) as Result.Result<TypedApplyResult<S, K>, DomainError>

/**
 * Type-level alias preserved for documentation: the set of
 * `BookingState` values that are *not* terminal. Equal to
 * `"Held" | "Confirmed"`. Useful when writing functions that take an
 * "active aggregate that may transition" without spelling the union.
 */
export type ActiveState = Exclude<BookingState, "Cancelled" | "Completed" | "NoShow">
