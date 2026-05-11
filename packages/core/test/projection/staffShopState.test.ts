import { describe, expect, it } from "vitest"
import {
  applyStaffShopStateDelta,
  computeStaffShopStateDelta,
  isEmptyStaffShopStateDelta,
  type StaffProjectionEntry,
  type StaffShopState,
} from "../../src/projection/shopState.js"

const entry = (
  id: string,
  displaySeq: number,
  opts?: Partial<StaffProjectionEntry>,
): StaffProjectionEntry => ({
  id,
  seq: opts?.seq ?? displaySeq,
  lane: opts?.lane ?? "walkIn",
  displaySeq,
  appointmentAt: opts?.appointmentAt ?? null,
  state: opts?.state ?? "Waiting",
  nameKana: opts?.nameKana ?? "ヤマダ",
  phoneLast4: opts?.phoneLast4 ?? "1234",
  freeText: opts?.freeText ?? null,
})

const baseSnap = (): StaffShopState => ({
  v: 6,
  waitingCount: 0,
  callableNowCount: 0,
  laneCounts: { walkIn: 0, priority: 0, reservation: 0 },
  calling: [],
  serving: [],
  pendingNoShow: [],
  waitingPreview: [],
  terminal: [],
  nextReservationDeadline: null,
})

describe("staff frame variant — compute/apply/isEmpty (ADR-0083)", () => {
  it("identity: prev === next yields an empty delta and applyDelta is a no-op", () => {
    const a = baseSnap()
    const delta = computeStaffShopStateDelta(a, a)
    expect(isEmptyStaffShopStateDelta(delta)).toBe(true)
    expect(applyStaffShopStateDelta(a, delta)).toEqual(a)
  })

  it("primitive + laneCounts change carries only changed fields", () => {
    const a = baseSnap()
    const b: StaffShopState = {
      ...a,
      waitingCount: 3,
      callableNowCount: 2,
      laneCounts: { walkIn: 2, priority: 1, reservation: 0 },
    }
    const delta = computeStaffShopStateDelta(a, b)
    expect(delta.waitingCount).toBe(3)
    expect(delta.callableNowCount).toBe(2)
    expect(delta.laneCounts).toEqual({ walkIn: 2, priority: 1, reservation: 0 })
    expect(applyStaffShopStateDelta(a, delta)).toEqual(b)
  })

  it("nextReservationDeadline carries null when transitioning from set to null", () => {
    const a: StaffShopState = { ...baseSnap(), nextReservationDeadline: "2026-05-12T05:00:00Z" }
    const b: StaffShopState = { ...a, nextReservationDeadline: null }
    const delta = computeStaffShopStateDelta(a, b)
    expect(delta.nextReservationDeadline).toBeNull()
    expect(applyStaffShopStateDelta(a, delta)).toEqual(b)
  })

  it("calling array delta: added / removed / updated all surface, PII included", () => {
    const x = entry("tkt_x", 1, { nameKana: "サトウ" })
    const y = entry("tkt_y", 2)
    const z = entry("tkt_z", 3, { phoneLast4: "9999" })
    const yUpdated = entry("tkt_y", 2, { state: "Called", freeText: "メモ追加" })
    const a: StaffShopState = { ...baseSnap(), calling: [x, y] }
    const b: StaffShopState = { ...a, calling: [yUpdated, z] }
    const delta = computeStaffShopStateDelta(a, b)
    expect(delta.calling?.added).toEqual([z])
    expect(delta.calling?.removed).toEqual(["tkt_x"])
    expect(delta.calling?.updated).toEqual([yUpdated])
    const merged = applyStaffShopStateDelta(a, delta)
    expect(merged.calling.map((t) => t.id)).toEqual(["tkt_y", "tkt_z"])
    expect(merged.calling[0]?.freeText).toBe("メモ追加")
    expect(merged.calling[1]?.phoneLast4).toBe("9999")
  })

  it("PII-only change surfaces as updated (nameKana correction)", () => {
    const before = entry("tkt_a", 1, { nameKana: "ヤマダ" })
    const after = entry("tkt_a", 1, { nameKana: "ヤマダタロウ" })
    const a: StaffShopState = { ...baseSnap(), calling: [before] }
    const b: StaffShopState = { ...a, calling: [after] }
    const delta = computeStaffShopStateDelta(a, b)
    expect(delta.calling?.updated).toEqual([after])
  })

  it("freeText null → string is an updated entry", () => {
    const before = entry("tkt_a", 1, { freeText: null })
    const after = entry("tkt_a", 1, { freeText: "新規メモ" })
    const a: StaffShopState = { ...baseSnap(), calling: [before] }
    const b: StaffShopState = { ...a, calling: [after] }
    const delta = computeStaffShopStateDelta(a, b)
    expect(delta.calling?.updated?.[0]?.freeText).toBe("新規メモ")
  })

  it("pendingNoShow / waitingPreview / serving are independently diffed", () => {
    const a = baseSnap()
    const p = entry("p1", 1)
    const w = entry("w1", 1)
    const s = entry("s1", 1)
    const b: StaffShopState = {
      ...a,
      pendingNoShow: [p],
      waitingPreview: [w],
      serving: [s],
    }
    const delta = computeStaffShopStateDelta(a, b)
    expect(delta.pendingNoShow?.added).toEqual([p])
    expect(delta.waitingPreview?.added).toEqual([w])
    expect(delta.serving?.added).toEqual([s])
    expect(applyStaffShopStateDelta(a, delta)).toEqual(b)
  })

  it("terminal column diffs independently and applyDelta round-trips", () => {
    const before = entry("t1", 1, { state: "Served" })
    const after = entry("t2", 2, { state: "Cancelled" })
    const a: StaffShopState = { ...baseSnap(), terminal: [before] }
    const b: StaffShopState = { ...a, terminal: [before, after] }
    const delta = computeStaffShopStateDelta(a, b)
    expect(delta.terminal?.added).toEqual([after])
    expect(applyStaffShopStateDelta(a, delta).terminal.map((t) => t.id)).toEqual(["t1", "t2"])
    expect(isEmptyStaffShopStateDelta(delta)).toBe(false)
  })

  it("terminal-only field changes mark the delta as non-empty", () => {
    const t = entry("t1", 1, { state: "NoShow" })
    const a = baseSnap()
    const b: StaffShopState = { ...a, terminal: [t] }
    expect(isEmptyStaffShopStateDelta(computeStaffShopStateDelta(a, b))).toBe(false)
  })

  it("array delta is sorted by displaySeq after merge", () => {
    const a: StaffShopState = { ...baseSnap(), calling: [entry("a", 3), entry("b", 1)] }
    const b: StaffShopState = { ...a, calling: [entry("a", 3), entry("b", 1), entry("c", 2)] }
    const delta = computeStaffShopStateDelta(a, b)
    const merged = applyStaffShopStateDelta(a, delta)
    expect(merged.calling.map((t) => t.id)).toEqual(["b", "c", "a"])
  })

  it("removed-only delta empties an array variant", () => {
    const x = entry("x", 1)
    const a: StaffShopState = { ...baseSnap(), waitingPreview: [x] }
    const b: StaffShopState = { ...a, waitingPreview: [] }
    const delta = computeStaffShopStateDelta(a, b)
    expect(delta.waitingPreview?.removed).toEqual(["x"])
    expect(applyStaffShopStateDelta(a, delta).waitingPreview).toEqual([])
  })

  it("isEmpty rejects deltas that carry any field", () => {
    const a = baseSnap()
    const b: StaffShopState = { ...a, waitingCount: 1 }
    expect(isEmptyStaffShopStateDelta(computeStaffShopStateDelta(a, b))).toBe(false)
  })
})
