import type {
  EncodedCalledTicket,
  EncodedPendingNoShowTicket,
  EncodedTicket,
  EncodedWaitingTicket,
  Ticket,
  TicketId,
} from "@booking/core"
import { TicketSchema } from "@booking/core"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { buildShopState } from "../../src/server/durableObjects/Projector.js"

const SECOND = 1000
const MINUTE = 60 * SECOND
const NOW = Date.parse("2026-05-11T10:00:00.000Z")
const SERVING_THRESHOLD = 30 * SECOND

const mkWaiting = (
  i: number,
  partial: Partial<EncodedWaitingTicket> = {},
): EncodedWaitingTicket => ({
  id: `tkt_01j0a00000000000000000w00${String(i)}`,
  seq: i,
  lane: "walkIn",
  displaySeq: i,
  nameKana: "ヤマダ",
  phoneLast4: "1234",
  freeText: null,
  issuedAt: new Date(NOW - 60 * MINUTE).toISOString(),
  appointmentAt: null,
  checkedInAt: null,
  state: "Waiting",
  ...partial,
})

const mkCalled = (
  i: number,
  calledAt: string,
  partial: Partial<EncodedCalledTicket> = {},
): EncodedCalledTicket => ({
  id: `tkt_01j0a00000000000000000c00${String(i)}`,
  seq: i,
  lane: "walkIn",
  displaySeq: i,
  nameKana: "ヤマダ",
  phoneLast4: "1234",
  freeText: null,
  issuedAt: new Date(NOW - 60 * MINUTE).toISOString(),
  appointmentAt: null,
  checkedInAt: null,
  state: "Called",
  calledAt,
  calledBy: "staff",
  ...partial,
})

const mkPendingNoShow = (i: number): EncodedPendingNoShowTicket => ({
  id: `tkt_01j0a00000000000000000p00${String(i)}`,
  seq: i,
  lane: "walkIn",
  displaySeq: i,
  nameKana: "ヤマダ",
  phoneLast4: "1234",
  freeText: null,
  issuedAt: new Date(NOW - 60 * MINUTE).toISOString(),
  appointmentAt: null,
  checkedInAt: null,
  state: "PendingNoShow",
  calledAt: new Date(NOW - 10 * MINUTE).toISOString(),
  calledBy: "staff",
  markedAt: new Date(NOW - 5 * MINUTE).toISOString(),
  markedBy: "staff",
})

const decodeWaiting = (tickets: readonly EncodedTicket[]): Map<TicketId, Ticket> => {
  const m = new Map<TicketId, Ticket>()
  for (const t of tickets) {
    if ((t as { state: string }).state !== "Waiting") continue
    const decoded = Schema.decodeUnknownSync(TicketSchema)(t)
    m.set(decoded.id, decoded)
  }
  return m
}

describe("Projector.buildShopState", () => {
  it("partitions waiting into callable-now first, then by displaySeq", () => {
    const tickets: readonly EncodedTicket[] = [
      mkWaiting(3, { displaySeq: 3 }),
      mkWaiting(1, { displaySeq: 1 }),
      mkWaiting(2, { displaySeq: 2 }),
    ]
    const state = buildShopState({
      tickets,
      decodedWaiting: decodeWaiting(tickets),
      nowMs: NOW,
      servingThresholdMs: SERVING_THRESHOLD,
    })
    expect(state.waitingPreview.map((t) => t.displaySeq)).toEqual([1, 2, 3])
    expect(state.waitingCount).toBe(3)
    expect(state.callableNowCount).toBe(3)
  })

  it("orders not-yet reservations after callable, by appointmentAt", () => {
    const reservation = (i: number, apptOffsetMs: number): EncodedTicket =>
      mkWaiting(i, {
        lane: "reservation",
        displaySeq: i,
        appointmentAt: new Date(NOW + apptOffsetMs).toISOString(),
      })
    const tickets: readonly EncodedTicket[] = [
      reservation(1, 60 * MINUTE),
      mkWaiting(2, { displaySeq: 2 }),
      reservation(3, 30 * MINUTE),
    ]
    const state = buildShopState({
      tickets,
      decodedWaiting: decodeWaiting(tickets),
      nowMs: NOW,
      servingThresholdMs: SERVING_THRESHOLD,
    })
    expect(state.waitingPreview.map((t) => t.id)).toEqual([
      "tkt_01j0a00000000000000000w002",
      "tkt_01j0a00000000000000000w003",
      "tkt_01j0a00000000000000000w001",
    ])
    expect(state.nextReservationDeadline).toBe("2026-05-11T10:30:00Z")
  })

  it("splits Called into calling (recent) vs serving (>= threshold)", () => {
    const recent = new Date(NOW - 10 * SECOND).toISOString()
    const stale = new Date(NOW - 60 * SECOND).toISOString()
    const tickets: readonly EncodedTicket[] = [
      mkCalled(1, recent, { displaySeq: 1 }),
      mkCalled(2, stale, { displaySeq: 2 }),
      mkCalled(3, recent, { displaySeq: 3 }),
    ]
    const state = buildShopState({
      tickets,
      decodedWaiting: decodeWaiting(tickets),
      nowMs: NOW,
      servingThresholdMs: SERVING_THRESHOLD,
    })
    expect(state.calling.map((t) => t.id)).toEqual([
      "tkt_01j0a00000000000000000c001",
      "tkt_01j0a00000000000000000c003",
    ])
    expect(state.serving.map((t) => t.id)).toEqual(["tkt_01j0a00000000000000000c002"])
  })

  it("orders pendingNoShow by displaySeq asc", () => {
    const tickets: readonly EncodedTicket[] = [
      mkPendingNoShow(3),
      mkPendingNoShow(1),
      mkPendingNoShow(2),
    ]
    const state = buildShopState({
      tickets,
      decodedWaiting: decodeWaiting(tickets),
      nowMs: NOW,
      servingThresholdMs: SERVING_THRESHOLD,
    })
    expect(state.pendingNoShow.map((t) => t.displaySeq)).toEqual([1, 2, 3])
  })

  it("counts lanes only over waiting tickets", () => {
    const tickets: readonly EncodedTicket[] = [
      mkWaiting(1, { lane: "walkIn" }),
      mkWaiting(2, { lane: "priority" }),
      mkWaiting(3, { lane: "reservation", appointmentAt: new Date(NOW).toISOString() }),
      mkCalled(4, new Date(NOW - 10 * SECOND).toISOString(), { lane: "walkIn" }),
    ]
    const state = buildShopState({
      tickets,
      decodedWaiting: decodeWaiting(tickets),
      nowMs: NOW,
      servingThresholdMs: SERVING_THRESHOLD,
    })
    expect(state.laneCounts).toEqual({ walkIn: 1, priority: 1, reservation: 1 })
  })

  it("emits null nextReservationDeadline when no reservation has an appointment", () => {
    const tickets: readonly EncodedTicket[] = [
      mkWaiting(1, { lane: "walkIn" }),
      mkWaiting(2, { lane: "priority" }),
    ]
    const state = buildShopState({
      tickets,
      decodedWaiting: decodeWaiting(tickets),
      nowMs: NOW,
      servingThresholdMs: SERVING_THRESHOLD,
    })
    expect(state.nextReservationDeadline).toBeNull()
  })

  it("emits envelope v: 6", () => {
    const state = buildShopState({
      tickets: [],
      decodedWaiting: new Map<TicketId, Ticket>(),
      nowMs: NOW,
      servingThresholdMs: SERVING_THRESHOLD,
    })
    expect(state.v).toBe(6)
    expect(state.waitingCount).toBe(0)
    expect(state.callableNowCount).toBe(0)
  })
})
