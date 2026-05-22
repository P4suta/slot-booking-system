import type { Ticket } from "../api.js"
import { type StepperStepKey, stepperTerminalLabel } from "../messages.js"

type StepStatus = "done" | "current" | "todo" | "terminal"

// Column on the shared 4-track grid. Mapping is fixed so the same
// milestone always sits at the same x-position regardless of lane:
//
//   col 1: 受付 (walk-in) / 予約 (reservation)
//   col 2: 到着 (reservation only — empty slot for walk-in)
//   col 3: 呼出
//   col 4: 完了 / 終端ラベル
//
// Walk-in renders dots at [1, 3, 4]; reservation at [1, 2, 3, 4].
// The connector line spans col 1 → col 4 centers regardless, so a
// stack of mixed-lane cards keeps every dot vertically aligned.
type StepColumn = 1 | 2 | 3 | 4

const COLUMN_OF: Readonly<Record<StepperStepKey, StepColumn>> = {
  received: 1,
  reserved: 1,
  arrived: 2,
  called: 3,
  served: 4,
}

export type StepperStep = {
  readonly key: StepperStepKey
  readonly status: StepStatus
  readonly isDanger: boolean
  readonly nudgeCount: number
  readonly terminalLabel: string | null
  readonly column: StepColumn
}

// Single source of truth for the step layout per lane. Keeping
// happy-path-only avoids drawing branches that occur on a minority
// of tickets (Overdue / NoShow / Cancelled) and obscure the
// current location. Overdue is rendered as a danger-toned Called,
// not its own segment. Terminal (NoShow / Cancelled / Appointment-
// Lapsed) replaces the last dot with a branch label.
const stepKeysFor = (lane: Ticket["lane"]): readonly StepperStepKey[] =>
  lane === "reservation"
    ? (["reserved", "arrived", "called", "served"] as const)
    : (["received", "called", "served"] as const)

// `currentActiveIdx` is the index that should carry the highlight
// (or be replaced by the terminal label). For active states it
// points at the in-progress segment; for terminal states it points
// at the last segment (which is then re-rendered as terminal).
const currentActiveIdx = (ticket: Ticket, stepCount: number): number => {
  const isReservation = ticket.lane === "reservation"
  switch (ticket.state) {
    case "Waiting":
      return isReservation && ticket.checkedInAt !== null ? 1 : 0
    case "Called":
    case "Overdue":
      return isReservation ? 2 : 1
    case "Served":
      return stepCount - 1
    case "NoShow":
    case "Cancelled":
      return stepCount - 1
  }
}

export const computeSteps = (ticket: Ticket): readonly StepperStep[] => {
  const keys = stepKeysFor(ticket.lane)
  const activeIdx = currentActiveIdx(ticket, keys.length)
  return keys.map((key, idx): StepperStep => {
    const column = COLUMN_OF[key]
    if (idx < activeIdx) {
      return { key, status: "done", isDanger: false, nudgeCount: 0, terminalLabel: null, column }
    }
    if (idx > activeIdx) {
      return { key, status: "todo", isDanger: false, nudgeCount: 0, terminalLabel: null, column }
    }
    if (ticket.state === "Served") {
      return { key, status: "done", isDanger: false, nudgeCount: 0, terminalLabel: null, column }
    }
    if (ticket.state === "NoShow" || ticket.state === "Cancelled") {
      return {
        key,
        status: "terminal",
        isDanger: false,
        nudgeCount: 0,
        terminalLabel: stepperTerminalLabel(ticket.state, ticket.reason ?? null),
        column,
      }
    }
    if (ticket.state === "Overdue") {
      return {
        key,
        status: "current",
        isDanger: true,
        nudgeCount: ticket.nudgeCount ?? 0,
        terminalLabel: null,
        column,
      }
    }
    return { key, status: "current", isDanger: false, nudgeCount: 0, terminalLabel: null, column }
  })
}

/**
 * Progress as a 0..1 fraction along the col 1 → col 4 track. Used by
 * the connector's "done" overlay so a stack of mixed-lane cards
 * shows the same green bar reaching the same x for the same state.
 *
 * Currently mirrors the legacy "terminal collapses to full progress"
 * behaviour: a Cancelled ticket from the Waiting state still shows a
 * full bar (the terminal cap sits at col 4). That mid-flow accuracy
 * loss is a separate UX call from alignment.
 */
export const stepperProgress = (steps: readonly StepperStep[]): number => {
  let reached: StepColumn | 0 = 0
  for (const step of steps) {
    if (step.status === "done" || step.status === "terminal" || step.status === "current") {
      if (step.column > reached) reached = step.column
    }
  }
  if (reached === 0) return 0
  return (reached - 1) / 3
}
