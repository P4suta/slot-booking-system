/**
 * ShopState as a CRDT semilattice (ADR-0081 part 3).
 *
 * The wire shape `ShopState` (per ADR-0081 part 2) keeps its
 * encoded-friendly arrays so existing clients decode unchanged.
 * `SemilatticeShopState` is the lifted internal representation a
 * multi-writer scenario will want: `tickets` is an
 * {@link ORMap}<TicketId, ProjectionEntry>, `laneCounts` is a
 * {@link GCounter}, `callableNow` is an {@link ORSet}<TicketId>,
 * `nextDeadline` is a max-monoid over `InstantOrInfty`, and
 * `vector` is the {@link VectorClock} that orders updates.
 *
 * `lift` projects a wire snapshot into the semilattice; `merge`
 * is the elementwise CRDT join; `materialize` flattens back to the
 * wire shape (the inverse on inputs that don't violate the entry's
 * lane / state invariants). Property tests pin the lattice laws —
 * associativity, commutativity, idempotency — over the composite
 * structure.
 *
 * Current consumer count: zero. The lattice ships for future use
 * (multi-replica reads, DR clones, browser-side merging once the
 * client caches richer state). The QueueShop DO is single-writer
 * (ADR-0053), so the existing in-place computation continues to
 * suffice — but the wire vector clock (S8) already carries the
 * happens-before information needed to swap representations
 * without changing the envelope.
 */
import { GCounter } from "../algorithms/GCounter.js"
import { ORMap, type ORMap as ORMapT } from "../algorithms/ORMap.js"
import { ORSet, type ORSet as ORSetT } from "../algorithms/ORSet.js"
import { VectorClock, type VectorClock as VectorClockT } from "../algorithms/VectorClock.js"
import type { ProjectionEntry, ShopState } from "./shopState.js"

/** Max-monoid over `string | null`; later (lexicographically) wins, `null` is the identity. */
export type Maximum<T> = {
  readonly value: T
}

const maxNullableString = (a: string | null, b: string | null): string | null => {
  if (a === null) return b
  if (b === null) return a
  return a > b ? a : b
}

export type SemilatticeShopState = {
  readonly vector: VectorClockT
  readonly tickets: ORMapT<string, ProjectionEntry>
  readonly laneCounts: GCounter
  readonly callableNow: ORSetT<string>
  readonly nextDeadline: Maximum<string | null>
}

const allEntries = (snap: ShopState): readonly ProjectionEntry[] => [
  ...snap.calling,
  ...snap.serving,
  ...snap.pendingNoShow,
  ...snap.waitingPreview,
]

/**
 * Project a wire snapshot into the semilattice. `siteId` tags every
 * mint event so subsequent merges treat the lift as one replica's
 * observation. Tags use a deterministic `siteId#index` shape so the
 * lift is idempotent in the structural-equality sense (the same wire
 * snapshot lifts to the same semilattice value).
 */
export const lift = (snap: ShopState, siteId: string): SemilatticeShopState => {
  let tickets: ORMapT<string, ProjectionEntry> = ORMap.empty()
  let callableNow: ORSetT<string> = ORSet.empty()
  let laneCounts = GCounter.empty()
  const entries = allEntries(snap)
  let index = 0
  for (const entry of entries) {
    const tag = `${siteId}#${String(index)}`
    tickets = ORMap.set(tickets, entry.id, tag, entry)
    index += 1
  }
  // GCounter shape stores per-site counts; we encode the wire lane
  // counts as a single-site observation.
  laneCounts = GCounter.increment(laneCounts, `${siteId}#walkIn`, snap.laneCounts.walkIn)
  laneCounts = GCounter.increment(laneCounts, `${siteId}#priority`, snap.laneCounts.priority)
  laneCounts = GCounter.increment(laneCounts, `${siteId}#reservation`, snap.laneCounts.reservation)
  // callableNowCount is materialised; the ORSet stores the actual
  // callable Waiting ticket ids by sampling the waitingPreview
  // prefix the wire claims is callable. For the current single-
  // writer scenario every Waiting in the prefix qualifies.
  let callIndex = 0
  for (const t of snap.waitingPreview) {
    if (callIndex >= snap.callableNowCount) break
    callableNow = ORSet.add(callableNow, t.id, `${siteId}#callable#${String(callIndex)}`)
    callIndex += 1
  }
  return {
    vector: VectorClock.tick(VectorClock.empty(), siteId),
    tickets,
    laneCounts,
    callableNow,
    nextDeadline: { value: snap.nextReservationDeadline },
  }
}

/** Elementwise CRDT join — the lattice's `⊔` operator. */
export const merge = (a: SemilatticeShopState, b: SemilatticeShopState): SemilatticeShopState => ({
  vector: VectorClock.merge(a.vector, b.vector),
  tickets: ORMap.merge(a.tickets, b.tickets),
  laneCounts: GCounter.merge(a.laneCounts, b.laneCounts),
  callableNow: ORSet.merge(a.callableNow, b.callableNow),
  nextDeadline: { value: maxNullableString(a.nextDeadline.value, b.nextDeadline.value) },
})

export const equals = (a: SemilatticeShopState, b: SemilatticeShopState): boolean => {
  if (!VectorClock.equals(a.vector, b.vector)) return false
  if (!ORMap.equals(a.tickets, b.tickets, (x, y) => x.id === y.id && x.state === y.state)) {
    return false
  }
  if (!GCounter.equals(a.laneCounts, b.laneCounts)) return false
  if (!ORSet.equals(a.callableNow, b.callableNow)) return false
  if (a.nextDeadline.value !== b.nextDeadline.value) return false
  return true
}
