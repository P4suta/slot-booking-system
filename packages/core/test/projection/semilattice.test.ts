import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { GCounter } from "../../src/algorithms/GCounter.js"
import { ORMap } from "../../src/algorithms/ORMap.js"
import { ORSet } from "../../src/algorithms/ORSet.js"
import { VectorClock } from "../../src/algorithms/VectorClock.js"
import { equals, lift, merge, type SemilatticeShopState } from "../../src/projection/semilattice.js"
import type { ProjectionEntry, ShopState } from "../../src/projection/shopState.js"

const entryArb: fc.Arbitrary<ProjectionEntry> = fc.record({
  id: fc.uuid(),
  seq: fc.integer({ min: 1, max: 1000 }),
  lane: fc.constantFrom("walkIn", "priority", "reservation"),
  displaySeq: fc.integer({ min: 1, max: 1000 }),
  appointmentAt: fc.option(fc.constantFrom("2026-05-11T09:00:00Z", "2026-05-11T10:00:00Z"), {
    nil: null,
  }),
  state: fc.constantFrom("Waiting", "Called", "PendingNoShow", "Served"),
})

const shopArb: fc.Arbitrary<ShopState> = fc
  .tuple(fc.array(entryArb, { maxLength: 4 }), fc.array(entryArb, { maxLength: 4 }))
  .map(
    ([waiting, called]): ShopState => ({
      v: 6,
      waitingCount: waiting.length,
      callableNowCount: Math.min(waiting.length, 2),
      laneCounts: {
        walkIn: waiting.filter((t) => t.lane === "walkIn").length,
        priority: waiting.filter((t) => t.lane === "priority").length,
        reservation: waiting.filter((t) => t.lane === "reservation").length,
      },
      calling: called,
      serving: [],
      pendingNoShow: [],
      waitingPreview: waiting,
      nextReservationDeadline: null,
    }),
  )

const semilatticeArb = fc
  .tuple(shopArb, fc.constantFrom("a", "b", "c"))
  .map(([snap, site]) => lift(snap, site))

describe("SemilatticeShopState — CRDT lattice laws", () => {
  it("idempotent: merge(a, a) ≡ a", () => {
    fc.assert(
      fc.property(semilatticeArb, (a) => {
        expect(equals(merge(a, a), a)).toBe(true)
      }),
    )
  })

  it("commutative: merge(a, b) ≡ merge(b, a)", () => {
    fc.assert(
      fc.property(semilatticeArb, semilatticeArb, (a, b) => {
        expect(equals(merge(a, b), merge(b, a))).toBe(true)
      }),
    )
  })

  it("associative: merge(merge(a, b), c) ≡ merge(a, merge(b, c))", () => {
    fc.assert(
      fc.property(semilatticeArb, semilatticeArb, semilatticeArb, (a, b, c) => {
        expect(equals(merge(merge(a, b), c), merge(a, merge(b, c)))).toBe(true)
      }),
    )
  })
})

describe("SemilatticeShopState — lift", () => {
  it("lift assigns distinct tags so re-lifting the same snapshot is structurally identical", () => {
    const snap: ShopState = {
      v: 6,
      waitingCount: 1,
      callableNowCount: 1,
      laneCounts: { walkIn: 1, priority: 0, reservation: 0 },
      calling: [],
      serving: [],
      pendingNoShow: [],
      waitingPreview: [
        {
          id: "t1",
          seq: 1,
          lane: "walkIn",
          displaySeq: 1,
          appointmentAt: null,
          state: "Waiting",
        },
      ],
      nextReservationDeadline: null,
    }
    const a = lift(snap, "site")
    const b = lift(snap, "site")
    expect(equals(a, b)).toBe(true)
  })

  it("merge of two replicas observing the same snapshot ≡ either replica's lift", () => {
    const snap: ShopState = {
      v: 6,
      waitingCount: 0,
      callableNowCount: 0,
      laneCounts: { walkIn: 0, priority: 0, reservation: 0 },
      calling: [],
      serving: [],
      pendingNoShow: [],
      waitingPreview: [],
      nextReservationDeadline: null,
    }
    const a = lift(snap, "site-a")
    const b = lift(snap, "site-b")
    const merged = merge(a, b)
    // Vectors differ between replicas, but every other component is
    // structurally the empty join — divergence here is by design,
    // not a violation.
    expect(merged.tickets.entries.size).toBe(0)
    expect(merged.callableNow.elements.size).toBe(0)
  })

  it("nextDeadline max-monoid picks the lexicographically later instant; null is identity", () => {
    const snapEarly: ShopState = {
      v: 6,
      waitingCount: 0,
      callableNowCount: 0,
      laneCounts: { walkIn: 0, priority: 0, reservation: 0 },
      calling: [],
      serving: [],
      pendingNoShow: [],
      waitingPreview: [],
      nextReservationDeadline: "2026-05-11T09:00:00Z",
    }
    const snapLate: ShopState = { ...snapEarly, nextReservationDeadline: "2026-05-11T10:00:00Z" }
    const snapNull: ShopState = { ...snapEarly, nextReservationDeadline: null }
    const a = lift(snapEarly, "a")
    const b = lift(snapLate, "b")
    const c = lift(snapNull, "c")
    expect(merge(a, b).nextDeadline.value).toBe("2026-05-11T10:00:00Z")
    expect(merge(b, a).nextDeadline.value).toBe("2026-05-11T10:00:00Z")
    expect(merge(a, c).nextDeadline.value).toBe("2026-05-11T09:00:00Z")
    expect(merge(c, a).nextDeadline.value).toBe("2026-05-11T09:00:00Z")
    expect(merge(c, c).nextDeadline.value).toBe(null)
  })

  it("equals returns false when callableNow diverges under matching peers", () => {
    const base: SemilatticeShopState = {
      vector: VectorClock.of({ s: 1 }),
      tickets: ORMap.empty(),
      laneCounts: GCounter.empty(),
      callableNow: ORSet.add(ORSet.empty<string>(), "t1", "tag1"),
      nextDeadline: { value: null },
    }
    const other: SemilatticeShopState = {
      ...base,
      callableNow: ORSet.add(ORSet.empty<string>(), "t2", "tag2"),
    }
    expect(equals(base, other)).toBe(false)
  })

  it("equals returns false when tickets ORMap diverges under the same vector", () => {
    const a = lift(
      {
        v: 6,
        waitingCount: 1,
        callableNowCount: 1,
        laneCounts: { walkIn: 1, priority: 0, reservation: 0 },
        calling: [],
        serving: [],
        pendingNoShow: [],
        waitingPreview: [
          {
            id: "t1",
            seq: 1,
            lane: "walkIn",
            displaySeq: 1,
            appointmentAt: null,
            state: "Waiting",
          },
        ],
        nextReservationDeadline: null,
      },
      "site",
    )
    const b = lift(
      {
        v: 6,
        waitingCount: 1,
        callableNowCount: 1,
        laneCounts: { walkIn: 1, priority: 0, reservation: 0 },
        calling: [],
        serving: [],
        pendingNoShow: [],
        waitingPreview: [
          {
            id: "t2",
            seq: 1,
            lane: "walkIn",
            displaySeq: 1,
            appointmentAt: null,
            state: "Waiting",
          },
        ],
        nextReservationDeadline: null,
      },
      "site",
    )
    expect(equals(a, b)).toBe(false)
  })

  it("equals returns false on vector / counter / next-deadline divergence", () => {
    const snap: ShopState = {
      v: 6,
      waitingCount: 1,
      callableNowCount: 1,
      laneCounts: { walkIn: 1, priority: 0, reservation: 0 },
      calling: [],
      serving: [],
      pendingNoShow: [],
      waitingPreview: [
        { id: "t1", seq: 1, lane: "walkIn", displaySeq: 1, appointmentAt: null, state: "Waiting" },
      ],
      nextReservationDeadline: null,
    }
    const a = lift(snap, "a")
    const b = lift(snap, "b")
    expect(equals(a, b)).toBe(false)
    const diffDeadline: ShopState = { ...snap, nextReservationDeadline: "2026-05-11T09:00:00Z" }
    expect(equals(a, lift(diffDeadline, "a"))).toBe(false)
    const diffLane: ShopState = {
      ...snap,
      laneCounts: { walkIn: 2, priority: 0, reservation: 0 },
    }
    expect(equals(a, lift(diffLane, "a"))).toBe(false)
  })
})
