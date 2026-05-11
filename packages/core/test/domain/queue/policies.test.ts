import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
  type IsCallableNowInput,
  isCallableNow,
  Policies,
} from "../../../src/domain/queue/policies.js"
import { Duration } from "../../../src/domain/value-objects/Duration.js"

const FIVE_MIN_MS = 5 * 60 * 1000

const fixedNow = Date.UTC(2026, 4, 11, 9, 0, 0)
const isoAt = (offsetMs: number): string => new Date(fixedNow + offsetMs).toISOString()

const reservationAt = (offsetMs: number): IsCallableNowInput => ({
  lane: "reservation",
  appointmentAt: isoAt(offsetMs),
})

describe("Policies — canonical constants", () => {
  it("RESERVATION_GRACE is 5 minutes", () => {
    expect(Duration.toMillis(Policies.RESERVATION_GRACE)).toBe(FIVE_MIN_MS)
  })

  it("SERVING_THRESHOLD is 30 seconds", () => {
    expect(Duration.toMillis(Policies.SERVING_THRESHOLD)).toBe(30_000)
  })

  it("PENDING_NOSHOW_TTL is 10 minutes", () => {
    expect(Duration.toMillis(Policies.PENDING_NOSHOW_TTL)).toBe(10 * 60 * 1000)
  })

  it("BROADCAST_COALESCE is 100 ms", () => {
    expect(Duration.toMillis(Policies.BROADCAST_COALESCE)).toBe(100)
  })

  it("WS_KEEPALIVE is 30 seconds", () => {
    expect(Duration.toMillis(Policies.WS_KEEPALIVE)).toBe(30_000)
  })

  it("CHECK_IN_WINDOW is 10 minutes", () => {
    expect(Duration.toMillis(Policies.CHECK_IN_WINDOW)).toBe(10 * 60 * 1000)
  })

  it("RECONNECT_INITIAL / RECONNECT_CAP frame the backoff range", () => {
    expect(Duration.toMillis(Policies.RECONNECT_INITIAL)).toBe(500)
    expect(Duration.toMillis(Policies.RECONNECT_CAP)).toBe(30_000)
    expect(Duration.compare(Policies.RECONNECT_INITIAL, Policies.RECONNECT_CAP)).toBe(-1)
  })
})

describe("isCallableNow — EDF-lateness lens", () => {
  it("walk-in tickets are unconditionally callable", () => {
    fc.assert(
      fc.property(fc.option(fc.string(), { nil: null }), fc.integer({ min: 0 }), (appt, now) => {
        expect(isCallableNow({ lane: "walkIn", appointmentAt: appt }, now)).toBe(true)
      }),
    )
  })

  it("priority tickets are unconditionally callable", () => {
    fc.assert(
      fc.property(fc.option(fc.string(), { nil: null }), fc.integer({ min: 0 }), (appt, now) => {
        expect(isCallableNow({ lane: "priority", appointmentAt: appt }, now)).toBe(true)
      }),
    )
  })

  it("reservation with null appointmentAt fails open (callable)", () => {
    expect(isCallableNow({ lane: "reservation", appointmentAt: null }, fixedNow)).toBe(true)
  })

  it("reservation with unparsable appointmentAt fails open (callable)", () => {
    expect(isCallableNow({ lane: "reservation", appointmentAt: "not-a-date" }, fixedNow)).toBe(true)
  })

  it("reservation is callable inside the 5-min grace window", () => {
    expect(isCallableNow(reservationAt(FIVE_MIN_MS - 1), fixedNow)).toBe(true)
    expect(isCallableNow(reservationAt(0), fixedNow)).toBe(true)
    expect(isCallableNow(reservationAt(-FIVE_MIN_MS), fixedNow)).toBe(true)
  })

  it("reservation is NOT callable outside the 5-min grace window", () => {
    expect(isCallableNow(reservationAt(FIVE_MIN_MS + 1), fixedNow)).toBe(false)
    expect(isCallableNow(reservationAt(60 * 60 * 1000), fixedNow)).toBe(false)
  })

  it("explicit grace argument overrides the default", () => {
    const tenMinGrace = Duration.minutes("Grace", 10)
    expect(isCallableNow(reservationAt(8 * 60 * 1000), fixedNow, tenMinGrace)).toBe(true)
    expect(isCallableNow(reservationAt(11 * 60 * 1000), fixedNow, tenMinGrace)).toBe(false)
  })

  it("default grace equals Policies.RESERVATION_GRACE", () => {
    fc.assert(
      fc.property(fc.integer({ min: -3600_000, max: 3600_000 }), (offsetMs) => {
        const t = reservationAt(offsetMs)
        expect(isCallableNow(t, fixedNow)).toBe(
          isCallableNow(t, fixedNow, Policies.RESERVATION_GRACE),
        )
      }),
    )
  })
})
