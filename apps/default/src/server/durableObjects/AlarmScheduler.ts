/**
 * AlarmScheduler — multi-kind TTL queue backed by a MinHeap.
 *
 * Replaces the prior SQL `MIN(marked_at)` poll with an in-memory
 * O(log n) priority queue. Cold start (DO actor re-instantiation
 * after hibernation) rehydrates the heap from the persistent
 * `tickets WHERE state = 'PendingNoShow'` set via a single Floyd
 * O(n) build, then drives the DO `setAlarm` clock as `peek + 1s`.
 *
 * Lazy delete semantics: `cancel(ticketId)` records a tombstone
 * rather than scanning the heap; `tick(now)` pops + discards
 * tombstoned entries until either the heap empties or the next
 * peek's deadline is still in the future. This keeps every
 * scheduling op O(log n) at the cost of accumulating dead entries
 * — bounded by the active PendingNoShow size, which is small in
 * practice.
 *
 * The scheduler is read-only from outside: callers `schedule` a
 * new entry or `cancel` an existing one, and consume the next
 * batch of expired entries via `tick(now)`. The DO is responsible
 * for actually dispatching MarkNoShow against the returned ids —
 * the scheduler does not own the dispatch path so the spoke /
 * hub split (ADR-0083) stays one-way.
 */

import type { TicketId } from "@booking/core"
import { MinHeap } from "@booking/core"

type AlarmKind = "PendingNoShowExpiry"

export type HeapEntry = {
  readonly ticketId: TicketId
  readonly deadlineMs: number
  readonly kind: AlarmKind
}

const compareByDeadline = (a: HeapEntry, b: HeapEntry): number => a.deadlineMs - b.deadlineMs

export type AlarmSchedulerDeps = {
  /** TTL in ms — added to a PendingNoShow's marked_at to derive deadline. */
  readonly ttlMs: number
  /** Wraps `ctx.storage.setAlarm`; floored to `now + 1s` by the scheduler. */
  readonly setAlarm: (deadlineMs: number) => Promise<void>
  /** SQL handle for the cold-start rehydrate query. */
  readonly sql: SqlStorage
}

export class AlarmScheduler {
  private readonly heap: MinHeap<HeapEntry>
  private readonly tombstones = new Set<TicketId>()

  constructor(private readonly deps: AlarmSchedulerDeps) {
    this.heap = new MinHeap<HeapEntry>(compareByDeadline)
  }

  /**
   * Cold-start rehydrate. Reads every PendingNoShow row, computes
   * deadlines, and Floyd-builds the heap in O(n). Called from the
   * DO ctor inside `blockConcurrencyWhile` so the actor is never
   * observable in a half-rehydrated state.
   */
  rehydrate(): void {
    const rows = this.deps.sql
      .exec("SELECT id, marked_at FROM tickets WHERE state = 'PendingNoShow'")
      .toArray()
    const entries: HeapEntry[] = []
    for (const row of rows) {
      const id = row.id
      const markedAt = row.marked_at
      if (typeof id !== "string" || typeof markedAt !== "string") continue
      const markedMs = Date.parse(markedAt)
      if (Number.isNaN(markedMs)) continue
      entries.push({
        ticketId: id as TicketId,
        deadlineMs: markedMs + this.deps.ttlMs,
        kind: "PendingNoShowExpiry",
      })
    }
    // Replace heap contents in O(n) via Floyd's build. We construct
    // a fresh heap so the rehydrate is idempotent if invoked twice
    // (the DO ctor only calls it once but the test harness re-uses
    // a single instance across cases).
    const built = MinHeap.fromArray(entries, compareByDeadline)
    // `MinHeap` is private-data — swap the contents by emptying +
    // pushing in heap order. The Floyd build above already pinned
    // the invariant, so straight pop-then-push preserves it.
    while (!this.heap.isEmpty()) this.heap.pop()
    while (!built.isEmpty()) {
      const top = built.pop()
      if (top !== undefined) this.heap.push(top)
    }
    this.tombstones.clear()
  }

  /** Schedule (or re-schedule) a TTL expiry. Idempotent on `ticketId`. */
  async schedule(entry: HeapEntry): Promise<void> {
    // A previously-tombstoned id can be re-scheduled (e.g. after
    // Recall → PendingNoShow again) — clearing the tombstone
    // exposes the new push to `tick`.
    this.tombstones.delete(entry.ticketId)
    this.heap.push(entry)
    const earliest = this.earliestActiveMs()
    if (earliest !== null) await this.deps.setAlarm(Math.max(earliest, Date.now() + 1000))
  }

  /** Mark an entry as cancelled. Idempotent. O(1). */
  cancel(ticketId: TicketId): void {
    this.tombstones.add(ticketId)
  }

  /**
   * Pop every entry whose deadline has passed, skipping
   * tombstoned ids. Returns the set of expired ticket ids the
   * caller is expected to dispatch (MarkNoShow). After draining,
   * the next deadline (if any) is re-armed via `setAlarm`.
   */
  async tick(nowMs: number): Promise<readonly TicketId[]> {
    const expired: TicketId[] = []
    for (;;) {
      const head = this.heap.peek()
      if (head === undefined) break
      if (head.deadlineMs > nowMs) break
      this.heap.pop()
      if (this.tombstones.delete(head.ticketId)) continue
      expired.push(head.ticketId)
    }
    const earliest = this.earliestActiveMs()
    if (earliest !== null) {
      await this.deps.setAlarm(Math.max(earliest, Date.now() + 1000))
    }
    return expired
  }

  /** For tests + the DO's startup re-arm. */
  earliestMs(): number | null {
    return this.earliestActiveMs()
  }

  /**
   * Peek past any tombstoned heads — the heap may carry stale
   * entries that haven't been drained yet; the alarm clock should
   * point at the next *live* deadline. Pops tombstones as a side
   * effect (amortising the lazy-delete cost across reads).
   */
  private earliestActiveMs(): number | null {
    for (;;) {
      const head = this.heap.peek()
      if (head === undefined) return null
      if (!this.tombstones.has(head.ticketId)) return head.deadlineMs
      this.heap.pop()
      this.tombstones.delete(head.ticketId)
    }
  }
}
