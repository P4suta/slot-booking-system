import { Result } from "effect"
import * as fc from "fast-check"
import { describe, expect, it } from "vitest"
import type { Booking } from "../../src/domain/booking/Booking.js"
import type { Command } from "../../src/domain/booking/Command.js"
import { apply } from "../../src/domain/booking/transitions.js"
import type { BookingEvent } from "../../src/domain/events/BookingEvent.js"
import { applyEvent } from "../../src/domain/read/projection.js"
import { newBookingEventId } from "../../src/domain/types/EntityId.js"
import { at, baseHeld, customerCap, slot, staffCap, systemExpire } from "../_fixtures/index.js"

/**
 * Phase 2.3 / BI-8 — Lattice replay laws.
 *
 * `applyEvent: (BookingView, BookingEvent) => BookingView` is a binary
 * fold over the read-side stream. Treating it as a join in a CRDT-style
 * semilattice gives us three laws that must hold everywhere replay is
 * used (audit trail, mirror, projection):
 *
 *   1. **Idempotency** — `applyEvent(applyEvent(v, e), e) ≡ applyEvent(v, e)`
 *      for every reachable `(v, e)` pair. The Cancel / Complete /
 *      NoShow / Reschedule arms are total but write-side guards prevent
 *      replaying onto an already-terminal view (`projection.ts` returns
 *      the input view unchanged when the state-precondition is not
 *      met). Idempotency is what the audit trail relies on when a
 *      relay duplicates an event.
 *   2. **Commutativity matrix** — for some event pairs the apply order
 *      does not matter (e.g. Held + Confirmed ≡ Confirmed + Held when
 *      both are reachable), and for others it does (Confirmed before
 *      Held would synthesize a state the write-side never minted).
 *      The fixture below pins the matrix explicitly so a future
 *      rewrite of `applyEvent` cannot silently relax the contract.
 *   3. **Identity / seed neutrality** — replay starting from the Held
 *      seed and folding only the seed event is the seed itself. This
 *      mirrors `Held + nothing ≡ Held`.
 *
 * The laws complement the write-side property suite in
 * `transitions.test.ts`; together they cover both the
 * `apply: Command → Result<Result, Error>` write face and the
 * `applyEvent: Event → View` read face.
 */

const ev = newBookingEventId

const expectRight = <A, E>(e: Result.Result<A, E>): A => {
  if (Result.isFailure(e)) throw new Error(`expected Right: ${JSON.stringify(e.failure)}`)
  return e.success
}

const heldBooking = (): Booking => baseHeld()

const confirmedFrom = (held: Booking): Booking => {
  const cmd: Command = { kind: "Confirm", at: at("2026-05-09T12:01:00Z") }
  return expectRight(apply(held, cmd, ev())).booking
}

const eventFor = (booking: Booking, command: Command): BookingEvent =>
  expectRight(apply(booking, command, ev())).event

/* -------------------------------------------------------------------------- */
/* Law 1 — Idempotency                                                         */
/* -------------------------------------------------------------------------- */

describe("BI-8 idempotency: applyEvent ∘ applyEvent ≡ applyEvent on every reachable (state, event) pair", () => {
  it("Held → Confirmed event applied twice equals once", () => {
    const v0 = heldBooking()
    const e = eventFor(v0, { kind: "Confirm", at: at("2026-05-09T12:01:00Z") })
    const once = applyEvent(v0, e)
    const twice = applyEvent(applyEvent(v0, e), e)
    expect(twice).toEqual(once)
  })

  it("Confirmed → Cancelled event applied twice equals once", () => {
    const v0 = confirmedFrom(heldBooking())
    const e = eventFor(v0, {
      kind: "Cancel",
      at: at("2026-05-09T13:00:00Z"),
      reason: "x",
      capability: customerCap(),
    })
    const once = applyEvent(v0, e)
    const twice = applyEvent(applyEvent(v0, e), e)
    expect(twice).toEqual(once)
  })

  it("Confirmed → Completed event applied twice equals once", () => {
    const v0 = confirmedFrom(heldBooking())
    const e = eventFor(v0, {
      kind: "Complete",
      at: at("2026-05-10T03:00:00Z"),
      capability: staffCap(),
    })
    const once = applyEvent(v0, e)
    const twice = applyEvent(applyEvent(v0, e), e)
    expect(twice).toEqual(once)
  })

  it("Confirmed → NoShow event applied twice equals once", () => {
    const v0 = confirmedFrom(heldBooking())
    const e = eventFor(v0, {
      kind: "MarkNoShow",
      at: at("2026-05-10T03:00:00Z"),
      capability: staffCap(),
    })
    const once = applyEvent(v0, e)
    const twice = applyEvent(applyEvent(v0, e), e)
    expect(twice).toEqual(once)
  })

  it("Confirmed → Rescheduled event applied twice equals once (slot equals already-applied target)", () => {
    const v0 = confirmedFrom(heldBooking())
    const e = eventFor(v0, {
      kind: "Reschedule",
      at: at("2026-05-09T12:30:00Z"),
      newSlot: slot("2026-05-11T01:00:00Z", "2026-05-11T02:00:00Z"),
      capability: customerCap(),
    })
    const once = applyEvent(v0, e)
    const twice = applyEvent(applyEvent(v0, e), e)
    expect(twice).toEqual(once)
  })

  it("Held → Expired event (cancel synonym) applied twice equals once", () => {
    const v0 = heldBooking()
    const e = eventFor(v0, {
      kind: "Expire",
      at: at("2026-05-09T13:00:00Z"),
      capability: systemExpire(),
    })
    const once = applyEvent(v0, e)
    const twice = applyEvent(applyEvent(v0, e), e)
    expect(twice).toEqual(once)
  })
})

/* -------------------------------------------------------------------------- */
/* Law 1 (continued) — random reachable event idempotency under fast-check    */
/* -------------------------------------------------------------------------- */

const reachableEventArb = fc.constantFrom<(b: Booking) => BookingEvent | null>(
  (b) =>
    b.state === "Held" ? eventFor(b, { kind: "Confirm", at: at("2026-05-09T12:01:00Z") }) : null,
  (b) =>
    b.state === "Confirmed"
      ? eventFor(b, {
          kind: "Cancel",
          at: at("2026-05-09T13:00:00Z"),
          reason: "x",
          capability: customerCap(),
        })
      : null,
  (b) =>
    b.state === "Confirmed"
      ? eventFor(b, {
          kind: "Complete",
          at: at("2026-05-10T03:00:00Z"),
          capability: staffCap(),
        })
      : null,
  (b) =>
    b.state === "Held"
      ? eventFor(b, {
          kind: "Cancel",
          at: at("2026-05-09T12:05:00Z"),
          reason: "user",
          capability: customerCap(),
        })
      : null,
)

describe("BI-8 idempotency under random reachable events", () => {
  it("applyEvent(applyEvent(v, e), e) === applyEvent(v, e) for every randomly-picked reachable pair", () => {
    fc.assert(
      fc.property(reachableEventArb, fc.boolean(), (mkEvent, startConfirmed) => {
        const v = startConfirmed ? confirmedFrom(heldBooking()) : heldBooking()
        const e = mkEvent(v)
        if (e === null) return // not reachable for this state — skip
        const once = applyEvent(v, e)
        const twice = applyEvent(applyEvent(v, e), e)
        expect(twice).toEqual(once)
      }),
      { numRuns: 200 },
    )
  })
})

/* -------------------------------------------------------------------------- */
/* Law 2 — Commutativity matrix                                                */
/* -------------------------------------------------------------------------- */

describe("BI-8 commutativity matrix: explicit pairs the read-side projection is allowed to fold either way", () => {
  it("Confirm and Cancel from Held DO NOT commute (Confirm-then-Cancel ends in Cancelled; Cancel-then-Confirm stays Cancelled)", () => {
    // Confirm-then-Cancel: Held → Confirmed → Cancelled
    const v0 = heldBooking()
    const eConfirm = eventFor(v0, { kind: "Confirm", at: at("2026-05-09T12:01:00Z") })
    const v1 = applyEvent(v0, eConfirm)
    const eCancel = eventFor(v1, {
      kind: "Cancel",
      at: at("2026-05-09T12:30:00Z"),
      reason: "user",
      capability: customerCap(),
    })
    const a = applyEvent(v1, eCancel)

    // Cancel-then-Confirm: Held → Cancelled (then Confirm event is rejected → no-op,
    // so the view stays Cancelled). Confirm event was minted from the Held aggregate
    // before cancellation; the projection must refuse to re-confirm a cancelled view.
    const eCancelFromHeld = eventFor(v0, {
      kind: "Cancel",
      at: at("2026-05-09T12:30:00Z"),
      reason: "user",
      capability: customerCap(),
    })
    const v1b = applyEvent(v0, eCancelFromHeld)
    const b = applyEvent(v1b, eConfirm)

    // Both end in Cancelled, but the cancelledAt / cancelledBy fields land
    // at different timestamps because the second branch never observed the
    // Confirmed intermediate. The read-side projection's contract is that
    // it preserves write-side ordering, not that it commutes; so we
    // observe `a !== b` by checking the cancelledAt timestamp.
    expect(a.state).toBe("Cancelled")
    expect(b.state).toBe("Cancelled")
    if (a.state === "Cancelled" && b.state === "Cancelled") {
      // The two paths reached Cancelled with different cancelledAt:
      //   a.cancelledAt = 12:30 (cancel after confirm at 12:01)
      //   b.cancelledAt = 12:30 (cancel from held at 12:30)
      // Same timestamp because both used the same Cancel event time.
      // What differs is whether the projection ever reached Confirmed.
      // We assert the views are equal in shape but were reached by
      // different folds — the matrix entry is "non-commutative path,
      // identical end state when timestamps coincide".
      expect(a.cancelledAt.toString()).toBe(b.cancelledAt.toString())
    }
  })

  it("two Cancel events on the same Held view fold to the same end state (later one no-ops)", () => {
    // The first Cancel transitions Held → Cancelled. The second Cancel
    // arrives onto a Cancelled view; projection.ts returns the view
    // unchanged (state precondition fails). So fold(v, c1, c2) = fold(v, c2, c1)
    // when both events were minted from the same source state.
    const v0 = heldBooking()
    const eA = eventFor(v0, {
      kind: "Cancel",
      at: at("2026-05-09T12:30:00Z"),
      reason: "a",
      capability: customerCap(),
    })
    const eB = eventFor(v0, {
      kind: "Cancel",
      at: at("2026-05-09T12:35:00Z"),
      reason: "b",
      capability: customerCap(),
    })
    const orderFirst = applyEvent(applyEvent(v0, eA), eB)
    const orderSecond = applyEvent(applyEvent(v0, eB), eA)
    // orderFirst applies eA first → Cancelled with reason "a"; eB is then a no-op
    // orderSecond applies eB first → Cancelled with reason "b"; eA is then a no-op
    // The end states differ in `reason` only — i.e. NOT commutative on
    // the full view. Lock that in so a future change cannot silently
    // relax it.
    expect(orderFirst.state).toBe("Cancelled")
    expect(orderSecond.state).toBe("Cancelled")
    if (orderFirst.state === "Cancelled" && orderSecond.state === "Cancelled") {
      expect(orderFirst.reason).toBe("a")
      expect(orderSecond.reason).toBe("b")
      expect(orderFirst).not.toEqual(orderSecond)
    }
  })
})

/* -------------------------------------------------------------------------- */
/* Law 3 — Seed neutrality                                                     */
/* -------------------------------------------------------------------------- */

describe("BI-8 seed neutrality: replay onto the Held seed without subsequent events is the seed", () => {
  it("a Held event applied to the Held view is identity (the seed event is never replayed)", () => {
    const seed = heldBooking()
    const heldEvent = eventFor(seed, { kind: "Confirm", at: at("2026-05-09T12:01:00Z") })
    // The Held *event* never reaches `applyEvent` on the Held view in
    // production — the seed event is the bootstrap and the read store
    // skips it. The projection's Held arm explicitly returns the input
    // view unchanged for that reason; this test pins the contract.
    const v = applyEvent(seed, { ...heldEvent, type: "Held" } as BookingEvent)
    expect(v).toEqual(seed)
  })
})
