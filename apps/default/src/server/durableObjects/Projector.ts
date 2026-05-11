/**
 * Projector — pure ShopState builder.
 *
 * The function `buildShopState` is the kernel of the QueueShop's
 * read-model derivation: encoded ticket rows + the current wall
 * clock + the SERVING_THRESHOLD cutoff produce the
 * {@link ShopStateWire} that flows over the WebSocket feed.
 *
 * No I/O, no class state, no Effect — the DO loads inputs (rows from
 * SqlStorage, `Date.now()`, env config) and hands them in; the
 * Projector returns the wire payload synchronously. This separation
 * makes the read-model independently testable (no DurableObjectStub
 * needed) and makes the DO's `computeShopState` a 5-line delegate.
 *
 * Ordering rules (ADR-0061 / 0062 / 0067 / 0071 / 0073):
 *   - Waiting: callable-now rows above not-yet rows (EDF lateness
 *     lens); within callable, FIFO by `displaySeq`; within not-yet,
 *     `appointmentAt` asc puts the soonest reservation first.
 *   - Called: split by `calledAt + SERVING_THRESHOLD_MS` cutoff into
 *     {@link ShopStateWire.calling} (recent) vs
 *     {@link ShopStateWire.serving} (older); both ordered by
 *     `displaySeq`.
 *   - PendingNoShow: `displaySeq` asc.
 *   - `nextReservationDeadline`: earliest `appointmentAt` among the
 *     decoded Waiting subset (ADR-0067 EDF deadline preview).
 */
import {
  type EncodedCalledTicket,
  type EncodedTicket,
  isCallableNow,
  type Lane,
  reservationsByDeadline,
  type ShopState as ShopStateWire,
  type StaffProjectionEntry,
  type StaffShopState,
  type Ticket,
  type TicketId,
} from "@booking/core"

export type ProjectorInputs = {
  readonly tickets: readonly EncodedTicket[]
  readonly decodedWaiting: ReadonlyMap<TicketId, Ticket>
  readonly nowMs: number
  readonly servingThresholdMs: number
}

const projectEntry = (t: EncodedTicket) => ({
  id: t.id,
  seq: t.seq,
  lane: t.lane,
  displaySeq: t.displaySeq,
  appointmentAt: t.appointmentAt,
  state: t.state,
})

const projectStaffEntry = (t: EncodedTicket): StaffProjectionEntry => ({
  id: t.id,
  seq: t.seq,
  lane: t.lane,
  displaySeq: t.displaySeq,
  appointmentAt: t.appointmentAt,
  state: t.state,
  nameKana: t.nameKana,
  phoneLast4: t.phoneLast4,
  freeText: t.freeText,
})

const apptMs = (t: EncodedTicket): number => {
  if (t.appointmentAt === null) return 0
  const ms = Date.parse(t.appointmentAt)
  return Number.isNaN(ms) ? 0 : ms
}

export const buildShopState = (inputs: ProjectorInputs): ShopStateWire => {
  const { tickets, decodedWaiting, nowMs, servingThresholdMs } = inputs
  const callable = (t: EncodedTicket): boolean => isCallableNow(t, nowMs)
  const waiting = tickets
    .filter((t) => t.state === "Waiting")
    .sort((a, b) => {
      const aCall = callable(a)
      const bCall = callable(b)
      if (aCall !== bCall) return aCall ? -1 : 1
      if (!aCall) {
        const d = apptMs(a) - apptMs(b)
        if (d !== 0) return d
      }
      return a.displaySeq - b.displaySeq
    })
  const calledAll = tickets
    .filter((t): t is EncodedCalledTicket => t.state === "Called")
    .sort((a, b) => a.displaySeq - b.displaySeq)
  const calling = calledAll.filter((t) => {
    const calledMs = Date.parse(t.calledAt)
    if (Number.isNaN(calledMs)) return true
    return calledMs + servingThresholdMs > nowMs
  })
  const serving = calledAll.filter((t) => {
    const calledMs = Date.parse(t.calledAt)
    if (Number.isNaN(calledMs)) return false
    return calledMs + servingThresholdMs <= nowMs
  })
  const pendingNoShow = tickets
    .filter((t) => t.state === "PendingNoShow")
    .sort((a, b) => a.displaySeq - b.displaySeq)
  const laneCount = (lane: Lane) => waiting.filter((t) => t.lane === lane).length
  const ranked = reservationsByDeadline({ tickets: decodedWaiting })
  const nextDeadline = ranked[0]?.appointmentAt ?? null
  return {
    v: 6 as const,
    waitingCount: waiting.length,
    callableNowCount: waiting.filter(callable).length,
    laneCounts: {
      walkIn: laneCount("walkIn"),
      priority: laneCount("priority"),
      reservation: laneCount("reservation"),
    },
    calling: calling.map(projectEntry),
    serving: serving.map(projectEntry),
    pendingNoShow: pendingNoShow.map(projectEntry),
    waitingPreview: waiting.map(projectEntry),
    nextReservationDeadline: nextDeadline !== null ? String(nextDeadline) : null,
  }
}

/**
 * Staff-frame variant of {@link buildShopState}. Identical partition
 * + sort semantics; each projection entry carries the PII fields
 * (`nameKana`, `phoneLast4`, `freeText`) so the staff WebSocket
 * feed can render the operator-facing dashboard without a separate
 * REST round-trip.
 */
export const buildStaffShopState = (inputs: ProjectorInputs): StaffShopState => {
  const { tickets, decodedWaiting, nowMs, servingThresholdMs } = inputs
  const callable = (t: EncodedTicket): boolean => isCallableNow(t, nowMs)
  const waiting = tickets
    .filter((t) => t.state === "Waiting")
    .sort((a, b) => {
      const aCall = callable(a)
      const bCall = callable(b)
      if (aCall !== bCall) return aCall ? -1 : 1
      if (!aCall) {
        const d = apptMs(a) - apptMs(b)
        if (d !== 0) return d
      }
      return a.displaySeq - b.displaySeq
    })
  const calledAll = tickets
    .filter((t): t is EncodedCalledTicket => t.state === "Called")
    .sort((a, b) => a.displaySeq - b.displaySeq)
  const calling = calledAll.filter((t) => {
    const calledMs = Date.parse(t.calledAt)
    if (Number.isNaN(calledMs)) return true
    return calledMs + servingThresholdMs > nowMs
  })
  const serving = calledAll.filter((t) => {
    const calledMs = Date.parse(t.calledAt)
    if (Number.isNaN(calledMs)) return false
    return calledMs + servingThresholdMs <= nowMs
  })
  const pendingNoShow = tickets
    .filter((t) => t.state === "PendingNoShow")
    .sort((a, b) => a.displaySeq - b.displaySeq)
  const laneCount = (lane: Lane) => waiting.filter((t) => t.lane === lane).length
  const ranked = reservationsByDeadline({ tickets: decodedWaiting })
  const nextDeadline = ranked[0]?.appointmentAt ?? null
  return {
    v: 6 as const,
    waitingCount: waiting.length,
    callableNowCount: waiting.filter(callable).length,
    laneCounts: {
      walkIn: laneCount("walkIn"),
      priority: laneCount("priority"),
      reservation: laneCount("reservation"),
    },
    calling: calling.map(projectStaffEntry),
    serving: serving.map(projectStaffEntry),
    pendingNoShow: pendingNoShow.map(projectStaffEntry),
    waitingPreview: waiting.map(projectStaffEntry),
    nextReservationDeadline: nextDeadline !== null ? String(nextDeadline) : null,
  }
}
