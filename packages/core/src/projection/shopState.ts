/**
 * ShopState — the anonymous projection wire shape (ADR-0061 / 0071 /
 * 0075). The server JSON.stringifies this shape; the client mirrors it
 * locally and merges deltas in place. The type lives in core so both
 * sides reach for the same source of truth.
 *
 * `state` discriminator on each entry is intentionally `string` rather
 * than `TicketState` to avoid a cycle through `TicketEvent`/`Ticket`
 * for what is, on the wire, just a tag the client passes through.
 */
export type LaneCounts = {
  readonly walkIn: number
  readonly priority: number
  readonly reservation: number
}

export type ProjectionEntry = {
  readonly id: string
  readonly seq: number
  readonly lane: "walkIn" | "priority" | "reservation"
  readonly displaySeq: number
  readonly appointmentAt: string | null
  readonly state: string
}

export type ShopState = {
  readonly v: 4
  readonly waitingCount: number
  readonly callableNowCount: number
  readonly laneCounts: LaneCounts
  readonly calling: readonly ProjectionEntry[]
  readonly serving: readonly ProjectionEntry[]
  readonly pendingNoShow: readonly ProjectionEntry[]
  readonly waitingPreview: readonly ProjectionEntry[]
  readonly nextReservationDeadline: string | null
}

/* -------------------------------------------------------------------------- */
/* Delta — only changed primitives + per-array add / remove / update sets.   */
/* Empty arrays are omitted; an entirely empty delta is equivalent to a       */
/* snapshot identity.                                                          */
/* -------------------------------------------------------------------------- */

export type ArrayDelta = {
  readonly added?: readonly ProjectionEntry[]
  readonly removed?: readonly string[]
  readonly updated?: readonly ProjectionEntry[]
}

export type ShopStateDelta = {
  readonly waitingCount?: number
  readonly callableNowCount?: number
  readonly laneCounts?: LaneCounts
  readonly nextReservationDeadline?: string | null
  readonly calling?: ArrayDelta
  readonly serving?: ArrayDelta
  readonly pendingNoShow?: ArrayDelta
  readonly waitingPreview?: ArrayDelta
}

/* -------------------------------------------------------------------------- */
/* Wire envelope (ADR-0075). v5 wraps either a full snapshot (sent on WS      */
/* connect or when the DO has no prior snapshot to diff against) or a delta   */
/* (sent on subsequent dispatches). The client picks branch by `kind`.        */
/* -------------------------------------------------------------------------- */

export type FeedMessage =
  | { readonly v: 5; readonly kind: "snapshot"; readonly snapshot: ShopState }
  | { readonly v: 5; readonly kind: "delta"; readonly delta: ShopStateDelta }

const sameLaneCounts = (a: LaneCounts, b: LaneCounts): boolean =>
  a.walkIn === b.walkIn && a.priority === b.priority && a.reservation === b.reservation

const sameProjectionEntry = (a: ProjectionEntry, b: ProjectionEntry): boolean =>
  a.id === b.id &&
  a.seq === b.seq &&
  a.lane === b.lane &&
  a.displaySeq === b.displaySeq &&
  a.appointmentAt === b.appointmentAt &&
  a.state === b.state

const arrayDelta = (
  prev: readonly ProjectionEntry[],
  next: readonly ProjectionEntry[],
): ArrayDelta | undefined => {
  const prevById = new Map(prev.map((t) => [t.id, t] as const))
  const nextById = new Map(next.map((t) => [t.id, t] as const))
  const added: ProjectionEntry[] = []
  const removed: string[] = []
  const updated: ProjectionEntry[] = []
  for (const t of next) {
    const prior = prevById.get(t.id)
    if (prior === undefined) {
      added.push(t)
    } else if (!sameProjectionEntry(prior, t)) {
      updated.push(t)
    }
  }
  for (const id of prevById.keys()) {
    if (!nextById.has(id)) removed.push(id)
  }
  if (added.length === 0 && removed.length === 0 && updated.length === 0) return undefined
  const out: { added?: ProjectionEntry[]; removed?: string[]; updated?: ProjectionEntry[] } = {}
  if (added.length > 0) out.added = added
  if (removed.length > 0) out.removed = removed
  if (updated.length > 0) out.updated = updated
  return out
}

const applyArrayDelta = (
  prev: readonly ProjectionEntry[],
  delta: ArrayDelta,
): readonly ProjectionEntry[] => {
  const removed = new Set(delta.removed ?? [])
  const updatedById = new Map((delta.updated ?? []).map((t) => [t.id, t] as const))
  const merged: ProjectionEntry[] = []
  for (const t of prev) {
    if (removed.has(t.id)) continue
    merged.push(updatedById.get(t.id) ?? t)
  }
  for (const t of delta.added ?? []) merged.push(t)
  merged.sort((a, b) => a.displaySeq - b.displaySeq)
  return merged
}

/**
 * Compute the minimal delta from `prev` to `next`. Returns the
 * delta envelope; if `prev` and `next` are byte-identical the
 * returned delta is the empty object `{}` (the caller can skip the
 * broadcast). The diff is per-field minimal: primitives only
 * appear when they changed; arrays only appear when they have at
 * least one add / remove / update.
 */
export const computeShopStateDelta = (prev: ShopState, next: ShopState): ShopStateDelta => {
  const out: {
    waitingCount?: number
    callableNowCount?: number
    laneCounts?: LaneCounts
    nextReservationDeadline?: string | null
    calling?: ArrayDelta
    serving?: ArrayDelta
    pendingNoShow?: ArrayDelta
    waitingPreview?: ArrayDelta
  } = {}
  if (prev.waitingCount !== next.waitingCount) out.waitingCount = next.waitingCount
  if (prev.callableNowCount !== next.callableNowCount) {
    out.callableNowCount = next.callableNowCount
  }
  if (!sameLaneCounts(prev.laneCounts, next.laneCounts)) out.laneCounts = next.laneCounts
  if (prev.nextReservationDeadline !== next.nextReservationDeadline) {
    out.nextReservationDeadline = next.nextReservationDeadline
  }
  const callingDelta = arrayDelta(prev.calling, next.calling)
  if (callingDelta !== undefined) out.calling = callingDelta
  const servingDelta = arrayDelta(prev.serving, next.serving)
  if (servingDelta !== undefined) out.serving = servingDelta
  const pendingDelta = arrayDelta(prev.pendingNoShow, next.pendingNoShow)
  if (pendingDelta !== undefined) out.pendingNoShow = pendingDelta
  const previewDelta = arrayDelta(prev.waitingPreview, next.waitingPreview)
  if (previewDelta !== undefined) out.waitingPreview = previewDelta
  return out
}

/**
 * Apply a delta to a snapshot. Returns a new ShopState with the
 * delta merged in. Idempotent: applying an empty delta returns a
 * structurally-equal snapshot. Used by the web client to advance
 * its local mirror, and by core property tests to pin
 * `applyDelta(prev, computeDelta(prev, next)) ≡ next`.
 */
export const applyShopStateDelta = (snap: ShopState, delta: ShopStateDelta): ShopState => ({
  v: 4,
  waitingCount: delta.waitingCount ?? snap.waitingCount,
  callableNowCount: delta.callableNowCount ?? snap.callableNowCount,
  laneCounts: delta.laneCounts ?? snap.laneCounts,
  nextReservationDeadline:
    delta.nextReservationDeadline === undefined
      ? snap.nextReservationDeadline
      : delta.nextReservationDeadline,
  calling:
    delta.calling === undefined ? snap.calling : applyArrayDelta(snap.calling, delta.calling),
  serving:
    delta.serving === undefined ? snap.serving : applyArrayDelta(snap.serving, delta.serving),
  pendingNoShow:
    delta.pendingNoShow === undefined
      ? snap.pendingNoShow
      : applyArrayDelta(snap.pendingNoShow, delta.pendingNoShow),
  waitingPreview:
    delta.waitingPreview === undefined
      ? snap.waitingPreview
      : applyArrayDelta(snap.waitingPreview, delta.waitingPreview),
})

/** Whether a delta carries any actual changes. */
export const isEmptyShopStateDelta = (d: ShopStateDelta): boolean =>
  d.waitingCount === undefined &&
  d.callableNowCount === undefined &&
  d.laneCounts === undefined &&
  d.nextReservationDeadline === undefined &&
  d.calling === undefined &&
  d.serving === undefined &&
  d.pendingNoShow === undefined &&
  d.waitingPreview === undefined
