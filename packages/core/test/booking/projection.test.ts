import { Result } from "effect"
import { describe, expect, it } from "vitest"
import type { Command } from "../../src/domain/booking/Command.js"
import { apply } from "../../src/domain/booking/transitions.js"
import { applyEvent, replay } from "../../src/domain/read/projection.js"
import { newBookingEventId } from "../../src/domain/types/EntityId.js"
import { at, baseHeld, customerCap, slot, staffCap } from "../_fixtures/index.js"

const ev = newBookingEventId

const expectRight = <A, E>(e: Result.Result<A, E>): A => {
  if (Result.isFailure(e)) {
    throw new Error(`expected Right: ${JSON.stringify(e.failure)}`)
  }
  return e.success
}

describe("applyEvent ↔ apply equivalence", () => {
  it("Held + Confirm → applyEvent(Held, ConfirmedEvent) === apply(...).booking", () => {
    const held = baseHeld()
    const cmd: Command = { kind: "Confirm", at: at("2026-05-09T12:01:00Z") }
    const r = expectRight(apply(held, cmd, ev()))
    const projected = applyEvent(held, r.event)
    expect(projected).toEqual(r.booking)
  })

  it("Held + Cancel → applyEvent matches apply", () => {
    const held = baseHeld()
    const cmd: Command = {
      kind: "Cancel",
      at: at("2026-05-09T12:01:00Z"),
      reason: "x",
      capability: customerCap(),
    }
    const r = expectRight(apply(held, cmd, ev()))
    const projected = applyEvent(held, r.event)
    expect(projected).toEqual(r.booking)
  })

  it("Confirmed + Reschedule → applyEvent matches apply (slot changes, confirmedAt preserved)", () => {
    const held = baseHeld()
    const confirmed = expectRight(
      apply(held, { kind: "Confirm", at: at("2026-05-09T12:01:00Z") }, ev()),
    ).booking
    const newSlot = slot("2026-05-11T01:00:00Z", "2026-05-11T02:00:00Z")
    const r = expectRight(
      apply(
        confirmed,
        {
          kind: "Reschedule",
          at: at("2026-05-09T13:00:00Z"),
          newSlot,
          capability: customerCap(),
        },
        ev(),
      ),
    )
    const projected = applyEvent(confirmed, r.event)
    expect(projected).toEqual(r.booking)
  })

  it("Confirmed + Complete → applyEvent matches apply", () => {
    const held = baseHeld()
    const confirmed = expectRight(
      apply(held, { kind: "Confirm", at: at("2026-05-09T12:01:00Z") }, ev()),
    ).booking
    const r = expectRight(
      apply(
        confirmed,
        { kind: "Complete", at: at("2026-05-10T03:00:00Z"), capability: staffCap() },
        ev(),
      ),
    )
    const projected = applyEvent(confirmed, r.event)
    expect(projected).toEqual(r.booking)
  })

  it("Confirmed + MarkNoShow → applyEvent matches apply", () => {
    const held = baseHeld()
    const confirmed = expectRight(
      apply(held, { kind: "Confirm", at: at("2026-05-09T12:01:00Z") }, ev()),
    ).booking
    const r = expectRight(
      apply(
        confirmed,
        { kind: "MarkNoShow", at: at("2026-05-10T03:00:00Z"), capability: staffCap() },
        ev(),
      ),
    )
    const projected = applyEvent(confirmed, r.event)
    expect(projected).toEqual(r.booking)
  })
})

describe("replay (full event stream → snapshot)", () => {
  it("Held + [Confirmed, Rescheduled, Completed] folds to Completed", () => {
    const held = baseHeld()
    const r1 = expectRight(apply(held, { kind: "Confirm", at: at("2026-05-09T12:01:00Z") }, ev()))
    const newSlot = slot("2026-05-11T01:00:00Z", "2026-05-11T02:00:00Z")
    const r2 = expectRight(
      apply(
        r1.booking,
        {
          kind: "Reschedule",
          at: at("2026-05-09T13:00:00Z"),
          newSlot,
          capability: customerCap(),
        },
        ev(),
      ),
    )
    const r3 = expectRight(
      apply(
        r2.booking,
        { kind: "Complete", at: at("2026-05-10T03:00:00Z"), capability: staffCap() },
        ev(),
      ),
    )
    const final = replay(held, [r1.event, r2.event, r3.event])
    expect(final).toEqual(r3.booking)
  })
})

describe("applyEvent no-op safety", () => {
  it("re-applying a Confirmed event to an already-Confirmed snapshot is a no-op", () => {
    const held = baseHeld()
    const r = expectRight(apply(held, { kind: "Confirm", at: at("2026-05-09T12:01:00Z") }, ev()))
    const reapplied = applyEvent(r.booking, r.event)
    expect(reapplied).toEqual(r.booking)
  })

  it("a Held event applied to an existing snapshot is a no-op (Held is the seed)", () => {
    const held = baseHeld()
    const r = expectRight(apply(held, { kind: "Confirm", at: at("2026-05-09T12:01:00Z") }, ev()))
    // Synthesize a Held event and replay onto Confirmed
    const heldAt = at("2026-05-09T11:00:00Z")
    const heldEvent = {
      id: newBookingEventId(),
      type: "Held" as const,
      bookingId: held.id,
      version: 1 as const,
      occurredAt: heldAt,
      recordedAt: heldAt,
      bookingCode: held.code,
      serviceId: held.serviceId,
      providerId: held.providerId,
      resourceIds: held.resourceIds,
      slot: held.slot,
    }
    const reapplied = applyEvent(r.booking, heldEvent)
    expect(reapplied).toEqual(r.booking)
  })

  it("applying a Reschedule event onto a non-Confirmed snapshot is a no-op", () => {
    const held = baseHeld()
    const cancelled = expectRight(
      apply(
        held,
        {
          kind: "Cancel",
          at: at("2026-05-09T12:01:00Z"),
          reason: "x",
          capability: customerCap(),
        },
        ev(),
      ),
    ).booking
    const newSlot = slot("2026-05-11T01:00:00Z", "2026-05-11T02:00:00Z")
    const rescheduleAt = at("2026-05-09T13:00:00Z")
    const fakeReschedule = {
      id: newBookingEventId(),
      type: "Rescheduled" as const,
      bookingId: cancelled.id,
      version: 1 as const,
      occurredAt: rescheduleAt,
      recordedAt: rescheduleAt,
      from: cancelled.slot,
      to: newSlot,
    }
    expect(applyEvent(cancelled, fakeReschedule)).toEqual(cancelled)
  })

  it("Complete/NoShow/Cancel events on terminal snapshot are no-ops", () => {
    const held = baseHeld()
    const cancelled = expectRight(
      apply(
        held,
        {
          kind: "Cancel",
          at: at("2026-05-09T12:01:00Z"),
          reason: "x",
          capability: customerCap(),
        },
        ev(),
      ),
    ).booking
    const tEv = at("2026-05-10T03:00:00Z")
    const baseE = (id: ReturnType<typeof newBookingEventId>) =>
      ({
        id,
        bookingId: cancelled.id,
        version: 1 as const,
        occurredAt: tEv,
        recordedAt: tEv,
      }) as const
    const completedEvent = { ...baseE(newBookingEventId()), type: "Completed" as const }
    expect(applyEvent(cancelled, completedEvent)).toEqual(cancelled)
    const noShowEvent = {
      ...baseE(newBookingEventId()),
      type: "NoShow" as const,
      by: "staff" as const,
    }
    expect(applyEvent(cancelled, noShowEvent)).toEqual(cancelled)
    const cancelledEvent = {
      ...baseE(newBookingEventId()),
      type: "Cancelled" as const,
      reason: "again",
      by: "system" as const,
    }
    expect(applyEvent(cancelled, cancelledEvent)).toEqual(cancelled)
  })
})
