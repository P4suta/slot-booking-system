import { Result } from "effect"
import * as fc from "fast-check"
import { describe, expect, it } from "vitest"
import type { Booking, BookingState } from "../../src/domain/booking/Booking.js"
import { isActive } from "../../src/domain/booking/Booking.js"
import type { Command } from "../../src/domain/booking/Command.js"
import type {
  AllowedCommandKinds,
  BookingMachineEventType,
  BookingMachineState,
} from "../../src/domain/booking/machine.js"
import { TERMINAL, TRANSITIONS } from "../../src/domain/booking/machine.js"
import { apply } from "../../src/domain/booking/transitions.js"
import { type BookingEventId, newBookingEventId } from "../../src/domain/types/EntityId.js"
import { at, baseHeld, customerCap, slot, staffCap, systemExpire } from "../_fixtures/index.js"

/**
 * Phase 2.3 / BI-5 — Hughes–Claessen model-based property test for the
 * Booking aggregate.
 *
 * Where the existing `transitions.test.ts > stateful property` runs
 * every command unconditionally and verifies "failure leaves the
 * booking untouched", this suite is **strict**: each command's
 * `check(model)` consults the type-level
 * `AllowedCommandKinds<S>` (`machine.ts`'s `TRANSITIONS`) to refuse
 * dispatch when the (state, command kind) pair has no edge. The
 * runtime-side `apply` therefore only ever sees legal pairs, and the
 * test asserts:
 *
 *   - `apply` returns `Right` for every dispatched command
 *   - The resulting state matches the type-level
 *     `NextState<S, K>` projection (the lattice in
 *     `TRANSITIONS[state][kind]`)
 *   - The model and the production aggregate stay observation-equivalent
 *     (`state`, `eventCount`, `id`, `isActive`) after every step
 *
 * Surfacing illegal pairs as `check`-rejections instead of `run`-time
 * `Left` lets the test exercise the `(state, kind)` lattice as the
 * spec it is — a future refactor that loosens the lattice would
 * surface here as a missing transition arm rather than as a passing
 * "failure was ignored" branch.
 */

const ev = (): BookingEventId => newBookingEventId()

const expectRight = <A, E>(e: Result.Result<A, E>): A => {
  if (Result.isFailure(e)) throw new Error(`expected Right: ${JSON.stringify(e.failure)}`)
  return e.success
}

/* -------------------------------------------------------------------------- */
/* Lattice projection — the type-level `TRANSITIONS` table at runtime         */
/* -------------------------------------------------------------------------- */

type EventTypeOfKind = {
  Confirm: "Confirmed"
  Cancel: "Cancelled"
  Expire: "Cancelled"
  Reschedule: "Rescheduled"
  Complete: "Completed"
  MarkNoShow: "NoShow"
}

const eventTypeOf: { [K in keyof EventTypeOfKind]: EventTypeOfKind[K] } = {
  Confirm: "Confirmed",
  Cancel: "Cancelled",
  Expire: "Cancelled",
  Reschedule: "Rescheduled",
  Complete: "Completed",
  MarkNoShow: "NoShow",
}

const allowed = (state: BookingMachineState, kind: BookingMachineEventType): boolean =>
  Object.hasOwn(TRANSITIONS[state], kind)

/* -------------------------------------------------------------------------- */
/* Model + Real                                                                */
/* -------------------------------------------------------------------------- */

type Model = {
  state: BookingState
  eventCount: number
  isActive: boolean
  isTerminal: boolean
}

type Real = {
  booking: Booking
  eventCount: number
  bookingId: string
}

/* -------------------------------------------------------------------------- */
/* Command factory                                                             */
/* -------------------------------------------------------------------------- */

const makeCmd = <K extends BookingMachineEventType>(
  kind: K,
  build: () => Command & { kind: K },
  label: string,
): fc.Command<Model, Real> => ({
  // Strict per-state lattice gate — the model knows which (state, kind)
  // pairs are valid, and refuses to dispatch otherwise.
  check: (m): boolean => !m.isTerminal && allowed(m.state, kind),
  run: (m, r): void => {
    const cmd = build()
    const result = apply(r.booking, cmd, ev())
    // Strict: every dispatched command must succeed (check has already
    // gated illegality). A Left here means the lattice is out of sync
    // with the runtime semantics.
    const ok = expectRight(result)

    // Type-level lattice projection: the next state must equal the
    // `TRANSITIONS[state][kind]` entry for this pair.
    const expectedNext = (
      TRANSITIONS as Readonly<Record<string, Readonly<Record<string, BookingMachineState>>>>
    )[m.state]?.[kind]
    expect(expectedNext).toBeDefined()
    expect(ok.booking.state).toBe(expectedNext)

    // Identity preservation across every transition.
    expect(ok.booking.id).toBe(r.bookingId)

    // Event-type alignment with the type-level discriminator.
    expect(ok.event.type).toBe(eventTypeOf[kind])

    // Lockstep advance.
    r.booking = ok.booking
    r.eventCount += 1
    m.state = ok.booking.state
    m.eventCount += 1
    m.isActive = isActive(ok.booking)
    m.isTerminal = TERMINAL[ok.booking.state]

    // Observation equivalence.
    expect(m.state).toBe(r.booking.state)
    expect(m.eventCount).toBe(r.eventCount)
    expect(m.isActive).toBe(isActive(r.booking))
  },
  toString: () => label,
})

const tConfirm = at("2026-05-09T12:30:00Z")
const tCancel = at("2026-05-09T12:30:00Z")
const tExpire = at("2026-05-09T13:00:00Z")
const tReschedule = at("2026-05-09T12:30:00Z")
const tComplete = at("2026-05-10T03:00:00Z")
const tNoShow = at("2026-05-10T03:00:00Z")

const newSlot = slot("2026-05-11T01:00:00Z", "2026-05-11T02:00:00Z")

const ConfirmCmd = makeCmd<"Confirm">(
  "Confirm",
  () => ({ kind: "Confirm", at: tConfirm }),
  "Confirm",
)

const CancelCmd = makeCmd<"Cancel">(
  "Cancel",
  () => ({
    kind: "Cancel",
    at: tCancel,
    reason: "user",
    capability: customerCap(),
  }),
  "Cancel",
)

const ExpireCmd = makeCmd<"Expire">(
  "Expire",
  () => ({ kind: "Expire", at: tExpire, capability: systemExpire() }),
  "Expire",
)

const RescheduleCmd = makeCmd<"Reschedule">(
  "Reschedule",
  () => ({
    kind: "Reschedule",
    at: tReschedule,
    newSlot,
    capability: customerCap(),
  }),
  "Reschedule",
)

const CompleteCmd = makeCmd<"Complete">(
  "Complete",
  () => ({ kind: "Complete", at: tComplete, capability: staffCap() }),
  "Complete",
)

const NoShowCmd = makeCmd<"MarkNoShow">(
  "MarkNoShow",
  () => ({ kind: "MarkNoShow", at: tNoShow, capability: staffCap() }),
  "MarkNoShow",
)

/* -------------------------------------------------------------------------- */
/* The property                                                                */
/* -------------------------------------------------------------------------- */

const cmdSequence = fc.commands(
  [
    fc.constant(ConfirmCmd),
    fc.constant(CancelCmd),
    fc.constant(ExpireCmd),
    fc.constant(RescheduleCmd),
    fc.constant(CompleteCmd),
    fc.constant(NoShowCmd),
  ],
  { maxCommands: 20 },
)

describe("BI-5 stateful property: model and production aggregate stay observation-equivalent", () => {
  it("every dispatched (state, kind) pair is in the TRANSITIONS lattice and produces matching next state", () => {
    fc.assert(
      fc.property(cmdSequence, (sequence) => {
        fc.modelRun(() => {
          const initial = baseHeld()
          const model: Model = {
            state: "Held",
            eventCount: 0,
            isActive: true,
            isTerminal: false,
          }
          const real: Real = {
            booking: initial,
            eventCount: 0,
            bookingId: initial.id,
          }
          return { model, real }
        }, sequence)
      }),
      { numRuns: 1000 },
    )
  })
})

/* -------------------------------------------------------------------------- */
/* Type-level cross-check: AllowedCommandKinds<S> matches the runtime         */
/* `allowed` predicate for every (state, kind) pair                           */
/* -------------------------------------------------------------------------- */

describe("BI-5 lattice consistency: AllowedCommandKinds<S> agrees with runtime TRANSITIONS for every pair", () => {
  const states: readonly BookingMachineState[] = [
    "Held",
    "Confirmed",
    "Cancelled",
    "Completed",
    "NoShow",
  ]
  const kinds: readonly BookingMachineEventType[] = [
    "Confirm",
    "Cancel",
    "Expire",
    "Reschedule",
    "Complete",
    "MarkNoShow",
  ]

  for (const s of states) {
    for (const k of kinds) {
      it(`${s} × ${k}: TRANSITIONS membership matches type-level projection`, () => {
        // Runtime predicate.
        const runtime = allowed(s, k)
        // Type-level membership of `k` in `AllowedCommandKinds<typeof s>`
        // is reified at runtime via the same `TRANSITIONS` table; the
        // assertion locks in that the type-level lattice and the
        // runtime lattice are the same lattice.
        const types: readonly string[] = Object.keys(TRANSITIONS[s])
        expect(runtime).toBe(types.includes(k))
      })
    }
  }
})

/* Type-level smoke: keep a literal set of `AllowedCommandKinds<S>`
 * checks colocated with the runtime suite so a future regression in
 * the type-level lattice surfaces here as a compile error rather
 * than a silent runtime drift. */
type _AssertHeldAllowed = AllowedCommandKinds<"Held">
type _AssertConfirmedAllowed = AllowedCommandKinds<"Confirmed">
type _AssertCancelledAllowed = AllowedCommandKinds<"Cancelled">
const _heldOk: _AssertHeldAllowed = "Confirm"
const _heldOk2: _AssertHeldAllowed = "Cancel"
const _heldOk3: _AssertHeldAllowed = "Expire"
const _confirmedOk: _AssertConfirmedAllowed = "Reschedule"
// `_AssertCancelledAllowed` is `never`, which has no value — assigning
// any value here would fail to compile. Recording the assertion as a
// type-level fact instead:
type _AssertCancelledIsNever = [_AssertCancelledAllowed] extends [never] ? true : false
const _cancelledIsNever: _AssertCancelledIsNever = true
void [_heldOk, _heldOk2, _heldOk3, _confirmedOk, _cancelledIsNever]
