import { describe, expect, it } from "vitest"
import type { Ticket } from "../../src/lib/api.js"
import { computeSteps, stepperProgress } from "../../src/lib/components/stepperLogic.js"

/**
 * Pin the stepper's step-array computation. The visual rendering
 * (SVG-ish dot list with connectors) is straightforward CSS once the
 * status array is correct; the only risk-laden code is the
 * lane × state × checkedInAt × cancelledReason → step-array mapping
 * tested here.
 */

const baseCommon = {
  id: "tk_test",
  seq: 1,
  displaySeq: 1,
  nameKana: "ヤマダ",
  phoneLast4: "1234",
  freeText: null,
  issuedAt: "2026-05-22T09:00:00.000Z",
  appointmentAt: null,
  checkedInAt: null,
} as const

const walkInTicket = (state: Ticket["state"], extra: Partial<Ticket> = {}): Ticket => ({
  ...baseCommon,
  lane: "walkIn",
  state,
  ...extra,
})

const reservationTicket = (state: Ticket["state"], extra: Partial<Ticket> = {}): Ticket => ({
  ...baseCommon,
  lane: "reservation",
  state,
  appointmentAt: "2026-05-22T10:00:00.000Z",
  ...extra,
})

describe("StateStepper.computeSteps — walk-in lane (3 segments)", () => {
  it("Waiting → current at segment 0", () => {
    const steps = computeSteps(walkInTicket("Waiting"))
    expect(steps.map((s) => s.status)).toEqual(["current", "todo", "todo"])
    expect(steps.map((s) => s.key)).toEqual(["received", "called", "served"])
    expect(steps[0]?.isDanger).toBe(false)
  })

  it("Called → done, current, todo", () => {
    const steps = computeSteps(walkInTicket("Called"))
    expect(steps.map((s) => s.status)).toEqual(["done", "current", "todo"])
    expect(steps[1]?.isDanger).toBe(false)
    expect(steps[1]?.nudgeCount).toBe(0)
  })

  it("Overdue → current at called segment with danger tone + nudge count", () => {
    const steps = computeSteps(walkInTicket("Overdue", { nudgeCount: 2 }))
    expect(steps.map((s) => s.status)).toEqual(["done", "current", "todo"])
    expect(steps[1]?.isDanger).toBe(true)
    expect(steps[1]?.nudgeCount).toBe(2)
  })

  it("Overdue without nudgeCount field → defaults to 0 (no badge rendered)", () => {
    const steps = computeSteps(walkInTicket("Overdue"))
    expect(steps[1]?.nudgeCount).toBe(0)
  })

  it("Served → all done", () => {
    const steps = computeSteps(walkInTicket("Served"))
    expect(steps.map((s) => s.status)).toEqual(["done", "done", "done"])
  })

  it("NoShow → last segment is terminal with 不在 label", () => {
    const steps = computeSteps(walkInTicket("NoShow"))
    expect(steps.map((s) => s.status)).toEqual(["done", "done", "terminal"])
    expect(steps[2]?.terminalLabel).toBe("不在")
  })

  it("Cancelled → last segment is terminal with キャンセル label", () => {
    const steps = computeSteps(walkInTicket("Cancelled"))
    expect(steps.map((s) => s.status)).toEqual(["done", "done", "terminal"])
    expect(steps[2]?.terminalLabel).toBe("キャンセル")
  })
})

describe("StateStepper.computeSteps — reservation lane (4 segments)", () => {
  it("step keys are reserved → arrived → called → served", () => {
    const steps = computeSteps(reservationTicket("Waiting"))
    expect(steps.map((s) => s.key)).toEqual(["reserved", "arrived", "called", "served"])
  })

  it("Waiting without check-in → current at reserved (segment 0)", () => {
    const steps = computeSteps(reservationTicket("Waiting"))
    expect(steps.map((s) => s.status)).toEqual(["current", "todo", "todo", "todo"])
  })

  it("Waiting after check-in → current advances to arrived (segment 1)", () => {
    const steps = computeSteps(
      reservationTicket("Waiting", { checkedInAt: "2026-05-22T09:50:00.000Z" }),
    )
    expect(steps.map((s) => s.status)).toEqual(["done", "current", "todo", "todo"])
  })

  it("Called → done, done, current, todo (called is segment 2)", () => {
    const steps = computeSteps(
      reservationTicket("Called", { checkedInAt: "2026-05-22T09:50:00.000Z" }),
    )
    expect(steps.map((s) => s.status)).toEqual(["done", "done", "current", "todo"])
  })

  it("Overdue → current at called segment (idx 2) with danger tone", () => {
    const steps = computeSteps(
      reservationTicket("Overdue", { checkedInAt: "2026-05-22T09:50:00.000Z", nudgeCount: 1 }),
    )
    expect(steps.map((s) => s.status)).toEqual(["done", "done", "current", "todo"])
    expect(steps[2]?.isDanger).toBe(true)
    expect(steps[2]?.nudgeCount).toBe(1)
  })

  it("Cancelled with reason=appointment_lapsed → terminal label 予約失効", () => {
    const steps = computeSteps(reservationTicket("Cancelled", { reason: "appointment_lapsed" }))
    expect(steps[3]?.status).toBe("terminal")
    expect(steps[3]?.terminalLabel).toBe("予約失効")
  })

  it("Cancelled with other reason → terminal label キャンセル", () => {
    const steps = computeSteps(reservationTicket("Cancelled", { reason: "customer_request" }))
    expect(steps[3]?.terminalLabel).toBe("キャンセル")
  })

  it("Cancelled with no reason field → terminal label キャンセル", () => {
    const steps = computeSteps(reservationTicket("Cancelled"))
    expect(steps[3]?.terminalLabel).toBe("キャンセル")
  })

  it("Served → all four done, no terminal label", () => {
    const steps = computeSteps(reservationTicket("Served"))
    expect(steps.map((s) => s.status)).toEqual(["done", "done", "done", "done"])
    expect(steps.every((s) => s.terminalLabel === null)).toBe(true)
  })
})

describe("StateStepper.computeSteps — column alignment (shared 4-track grid)", () => {
  it("walk-in step columns are [1, 3, 4] — col 2 (到着) skipped", () => {
    const steps = computeSteps(walkInTicket("Waiting"))
    expect(steps.map((s) => s.column)).toEqual([1, 3, 4])
  })

  it("reservation step columns are [1, 2, 3, 4] — every slot occupied", () => {
    const steps = computeSteps(reservationTicket("Waiting"))
    expect(steps.map((s) => s.column)).toEqual([1, 2, 3, 4])
  })

  it("called segment is always col 3 across lanes", () => {
    const walkInCalled = computeSteps(walkInTicket("Called"))
    const reservationCalled = computeSteps(reservationTicket("Called"))
    const walkInCalledStep = walkInCalled.find((s) => s.key === "called")
    const reservationCalledStep = reservationCalled.find((s) => s.key === "called")
    expect(walkInCalledStep?.column).toBe(3)
    expect(reservationCalledStep?.column).toBe(3)
  })

  it("served segment is always col 4 across lanes", () => {
    expect(computeSteps(walkInTicket("Served")).find((s) => s.key === "served")?.column).toBe(4)
    expect(computeSteps(reservationTicket("Served")).find((s) => s.key === "served")?.column).toBe(
      4,
    )
  })
})

describe("StateStepper.stepperProgress — done-bar fraction along col 1 → col 4", () => {
  it("Waiting (walk-in) → 0 (still at col 1)", () => {
    expect(stepperProgress(computeSteps(walkInTicket("Waiting")))).toBe(0)
  })

  it("Called (walk-in) → 2/3 (reached col 3)", () => {
    expect(stepperProgress(computeSteps(walkInTicket("Called")))).toBeCloseTo(2 / 3)
  })

  it("Called (reservation, no check-in) → 2/3 (reached col 3, same as walk-in)", () => {
    expect(stepperProgress(computeSteps(reservationTicket("Called")))).toBeCloseTo(2 / 3)
  })

  it("Waiting (reservation, checked-in) → 1/3 (reached col 2)", () => {
    expect(
      stepperProgress(
        computeSteps(reservationTicket("Waiting", { checkedInAt: "2026-05-22T09:50:00.000Z" })),
      ),
    ).toBeCloseTo(1 / 3)
  })

  it("Served → 1 (full bar)", () => {
    expect(stepperProgress(computeSteps(walkInTicket("Served")))).toBe(1)
    expect(stepperProgress(computeSteps(reservationTicket("Served")))).toBe(1)
  })

  it("terminal states reach col 4 (current implementation) → full bar", () => {
    expect(stepperProgress(computeSteps(walkInTicket("NoShow")))).toBe(1)
    expect(stepperProgress(computeSteps(walkInTicket("Cancelled")))).toBe(1)
  })
})

describe("StateStepper.computeSteps — invariants", () => {
  it("exactly one segment has current status when state is active", () => {
    const activeStates: readonly Ticket["state"][] = ["Waiting", "Called", "Overdue"]
    for (const state of activeStates) {
      const steps = computeSteps(walkInTicket(state))
      const currentCount = steps.filter((s) => s.status === "current").length
      expect(currentCount).toBe(1)
    }
  })

  it("no segment has terminal status when state is active or Served", () => {
    const nonTerminalStates: readonly Ticket["state"][] = ["Waiting", "Called", "Overdue", "Served"]
    for (const state of nonTerminalStates) {
      const steps = computeSteps(walkInTicket(state))
      const terminalCount = steps.filter((s) => s.status === "terminal").length
      expect(terminalCount).toBe(0)
    }
  })

  it("exactly the last segment carries the terminal label when state is NoShow/Cancelled", () => {
    for (const state of ["NoShow", "Cancelled"] as const) {
      const steps = computeSteps(walkInTicket(state))
      expect(steps[steps.length - 1]?.status).toBe("terminal")
      expect(steps.slice(0, -1).every((s) => s.status === "done")).toBe(true)
    }
  })
})
