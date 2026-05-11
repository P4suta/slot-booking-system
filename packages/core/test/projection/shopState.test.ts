import { describe, expect, it } from "vitest"
import {
  applyShopStateDelta,
  computeShopStateDelta,
  isEmptyShopStateDelta,
  type ProjectionEntry,
  type ShopState,
} from "../../src/projection/shopState.js"

const entry = (
  id: string,
  displaySeq: number,
  opts?: Partial<ProjectionEntry>,
): ProjectionEntry => ({
  id,
  seq: opts?.seq ?? displaySeq,
  lane: opts?.lane ?? "walkIn",
  displaySeq,
  appointmentAt: opts?.appointmentAt ?? null,
  state: opts?.state ?? "Waiting",
})

const baseSnap = (): ShopState => ({
  v: 6,
  waitingCount: 0,
  callableNowCount: 0,
  laneCounts: { walkIn: 0, priority: 0, reservation: 0 },
  calling: [],
  serving: [],
  pendingNoShow: [],
  waitingPreview: [],
  nextReservationDeadline: null,
})

describe("computeShopStateDelta / applyShopStateDelta (ADR-0075)", () => {
  it("identity: prev === next yields an empty delta and applyDelta is a no-op", () => {
    const a = baseSnap()
    const delta = computeShopStateDelta(a, a)
    expect(isEmptyShopStateDelta(delta)).toBe(true)
    expect(applyShopStateDelta(a, delta)).toEqual(a)
  })

  it("primitive change carries only the changed field", () => {
    const a = baseSnap()
    const b: ShopState = { ...a, waitingCount: 3, callableNowCount: 2 }
    const delta = computeShopStateDelta(a, b)
    expect(delta.waitingCount).toBe(3)
    expect(delta.callableNowCount).toBe(2)
    expect(delta.laneCounts).toBeUndefined()
    expect(applyShopStateDelta(a, delta)).toEqual(b)
  })

  it("laneCounts replaces the whole sub-object when any field differs", () => {
    const a = baseSnap()
    const b: ShopState = { ...a, laneCounts: { walkIn: 2, priority: 0, reservation: 0 } }
    const delta = computeShopStateDelta(a, b)
    expect(delta.laneCounts).toEqual({ walkIn: 2, priority: 0, reservation: 0 })
  })

  it("nextReservationDeadline carries `null` when transitioning from set to null", () => {
    const a: ShopState = { ...baseSnap(), nextReservationDeadline: "2026-05-12T05:00:00Z" }
    const b: ShopState = { ...a, nextReservationDeadline: null }
    const delta = computeShopStateDelta(a, b)
    expect(delta.nextReservationDeadline).toBeNull()
    expect(applyShopStateDelta(a, delta)).toEqual(b)
  })

  it("calling array delta: added / removed / updated all surface", () => {
    const x = entry("tkt_x", 1)
    const y = entry("tkt_y", 2)
    const z = entry("tkt_z", 3)
    const yUpdated = entry("tkt_y", 2, { state: "Called" })
    const a: ShopState = { ...baseSnap(), calling: [x, y] }
    const b: ShopState = { ...a, calling: [yUpdated, z] }
    const delta = computeShopStateDelta(a, b)
    expect(delta.calling?.added).toEqual([z])
    expect(delta.calling?.removed).toEqual(["tkt_x"])
    expect(delta.calling?.updated).toEqual([yUpdated])
    const merged = applyShopStateDelta(a, delta)
    expect(merged.calling.map((t) => t.id)).toEqual(["tkt_y", "tkt_z"])
    expect(merged.calling[0]?.state).toBe("Called")
  })

  it("array delta is sorted by displaySeq after merge", () => {
    const a: ShopState = { ...baseSnap(), calling: [entry("a", 3), entry("b", 1)] }
    const b: ShopState = { ...a, calling: [entry("a", 3), entry("b", 1), entry("c", 2)] }
    const delta = computeShopStateDelta(a, b)
    const merged = applyShopStateDelta(a, delta)
    expect(merged.calling.map((t) => t.id)).toEqual(["b", "c", "a"])
  })

  it("pendingNoShow / waitingPreview / serving are independently diffed", () => {
    const a = baseSnap()
    const p = entry("p1", 1)
    const w = entry("w1", 1)
    const s = entry("s1", 1)
    const b: ShopState = {
      ...a,
      pendingNoShow: [p],
      waitingPreview: [w],
      serving: [s],
    }
    const delta = computeShopStateDelta(a, b)
    expect(delta.pendingNoShow?.added).toEqual([p])
    expect(delta.waitingPreview?.added).toEqual([w])
    expect(delta.serving?.added).toEqual([s])
    expect(applyShopStateDelta(a, delta)).toEqual(b)
  })

  it("round-trip property: applyDelta(prev, computeDelta(prev, next)) ≡ next", () => {
    const a: ShopState = {
      ...baseSnap(),
      waitingCount: 5,
      callableNowCount: 3,
      laneCounts: { walkIn: 3, priority: 1, reservation: 1 },
      calling: [entry("c1", 1), entry("c2", 2)],
      serving: [entry("s1", 1)],
      pendingNoShow: [entry("p1", 1)],
      waitingPreview: [entry("w1", 1), entry("w2", 2)],
      nextReservationDeadline: "2026-05-12T06:00:00Z",
    }
    const b: ShopState = {
      ...a,
      waitingCount: 6,
      laneCounts: { walkIn: 4, priority: 1, reservation: 1 },
      calling: [entry("c2", 2), entry("c3", 3)],
      pendingNoShow: [],
      waitingPreview: [entry("w1", 1), entry("w2", 2), entry("w3", 3)],
    }
    const delta = computeShopStateDelta(a, b)
    expect(applyShopStateDelta(a, delta)).toEqual(b)
  })
})
