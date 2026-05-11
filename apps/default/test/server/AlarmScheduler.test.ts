import type { TicketId } from "@booking/core"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AlarmScheduler, type HeapEntry } from "../../src/server/durableObjects/AlarmScheduler.js"

const TTL_MS = 5 * 60 * 1000
const NOW = Date.parse("2026-05-11T10:00:00.000Z")

type Row = { readonly id: string; readonly marked_at: string }

const mkSql = (rows: readonly Row[]) =>
  ({
    exec: vi.fn(() => ({
      toArray: () => rows.slice(),
    })),
  }) as unknown as SqlStorage

const tid = (suffix: string): TicketId =>
  `tkt_01j0a00000000000000000${suffix}` as unknown as TicketId

const mkEntry = (id: TicketId, deadlineMs: number): HeapEntry => ({
  ticketId: id,
  deadlineMs,
  kind: "PendingNoShowExpiry",
})

describe("AlarmScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe("rehydrate", () => {
    it("yields an empty heap when SQL returns no PendingNoShow rows", () => {
      const sql = mkSql([])
      const setAlarm = vi.fn<(deadlineMs: number) => Promise<void>>().mockResolvedValue(undefined)
      const scheduler = new AlarmScheduler({ ttlMs: TTL_MS, setAlarm, sql })

      scheduler.rehydrate()

      expect(scheduler.earliestMs()).toBeNull()
      expect(setAlarm).not.toHaveBeenCalled()
    })

    it("Floyd-builds the heap from 3 rows so earliest = min(marked_at) + ttlMs", () => {
      const markedA = "2026-05-11T09:55:00.000Z" // earliest
      const markedB = "2026-05-11T09:57:00.000Z"
      const markedC = "2026-05-11T09:56:30.000Z"
      const sql = mkSql([
        { id: "tkt_01j0a00000000000000000aaa", marked_at: markedB },
        { id: "tkt_01j0a00000000000000000bbb", marked_at: markedA },
        { id: "tkt_01j0a00000000000000000ccc", marked_at: markedC },
      ])
      const setAlarm = vi.fn<(deadlineMs: number) => Promise<void>>().mockResolvedValue(undefined)
      const scheduler = new AlarmScheduler({ ttlMs: TTL_MS, setAlarm, sql })

      scheduler.rehydrate()

      expect(scheduler.earliestMs()).toBe(Date.parse(markedA) + TTL_MS)
    })
  })

  describe("schedule", () => {
    it("pushes a new entry, updates earliest, and calls setAlarm with the deadline floor", async () => {
      const sql = mkSql([])
      const setAlarm = vi.fn<(deadlineMs: number) => Promise<void>>().mockResolvedValue(undefined)
      const scheduler = new AlarmScheduler({ ttlMs: TTL_MS, setAlarm, sql })
      scheduler.rehydrate()

      const deadline = NOW + 3 * 60 * 1000
      await scheduler.schedule(mkEntry(tid("aaa"), deadline))

      expect(scheduler.earliestMs()).toBe(deadline)
      expect(setAlarm).toHaveBeenCalledTimes(1)
      // deadline (NOW + 3min) is comfortably past NOW + 1s, so floor stays at deadline.
      expect(setAlarm).toHaveBeenCalledWith(deadline)
    })

    it("applies the Date.now() + 1000 floor when the deadline is already in the past", async () => {
      const sql = mkSql([])
      const setAlarm = vi.fn<(deadlineMs: number) => Promise<void>>().mockResolvedValue(undefined)
      const scheduler = new AlarmScheduler({ ttlMs: TTL_MS, setAlarm, sql })
      scheduler.rehydrate()

      const stale = NOW - 60 * 1000
      await scheduler.schedule(mkEntry(tid("aaa"), stale))

      expect(setAlarm).toHaveBeenCalledWith(NOW + 1000)
    })

    it("clears any tombstone so a re-scheduled ticket is exposed to tick again", async () => {
      const sql = mkSql([])
      const setAlarm = vi.fn<(deadlineMs: number) => Promise<void>>().mockResolvedValue(undefined)
      const scheduler = new AlarmScheduler({ ttlMs: TTL_MS, setAlarm, sql })
      scheduler.rehydrate()

      const id = tid("aaa")
      const deadline = NOW + 2 * 60 * 1000
      await scheduler.schedule(mkEntry(id, deadline))
      scheduler.cancel(id)
      // Re-schedule with a later deadline — the tombstone must be cleared
      // so the new entry survives `tick`. (The heap does not de-dup by
      // ticketId, so the original push may still surface; what matters
      // is that the id is no longer suppressed.)
      const reDeadline = NOW + 4 * 60 * 1000
      await scheduler.schedule(mkEntry(id, reDeadline))

      const expired = await scheduler.tick(reDeadline)
      expect(expired).toContain(id)
    })
  })

  describe("cancel + tick", () => {
    it("skips tombstoned entries on tick", async () => {
      const sql = mkSql([])
      const setAlarm = vi.fn<(deadlineMs: number) => Promise<void>>().mockResolvedValue(undefined)
      const scheduler = new AlarmScheduler({ ttlMs: TTL_MS, setAlarm, sql })
      scheduler.rehydrate()

      const live = tid("aaa")
      const dead = tid("bbb")
      const deadline = NOW + 60 * 1000
      await scheduler.schedule(mkEntry(dead, deadline))
      await scheduler.schedule(mkEntry(live, deadline + 1000))
      scheduler.cancel(dead)

      const expired = await scheduler.tick(deadline + 1000)
      expect(expired).toEqual([live])
    })

    it("returns only entries whose deadline <= now and leaves future entries on the heap", async () => {
      const sql = mkSql([])
      const setAlarm = vi.fn<(deadlineMs: number) => Promise<void>>().mockResolvedValue(undefined)
      const scheduler = new AlarmScheduler({ ttlMs: TTL_MS, setAlarm, sql })
      scheduler.rehydrate()

      const past1 = tid("aaa")
      const past2 = tid("bbb")
      const future = tid("ccc")
      await scheduler.schedule(mkEntry(past1, NOW - 1000))
      await scheduler.schedule(mkEntry(past2, NOW - 500))
      await scheduler.schedule(mkEntry(future, NOW + 60 * 1000))

      const expired = await scheduler.tick(NOW)
      expect(new Set(expired)).toEqual(new Set([past1, past2]))
      expect(scheduler.earliestMs()).toBe(NOW + 60 * 1000)
    })

    it("re-arms setAlarm at the next earliest after draining expired entries", async () => {
      const sql = mkSql([])
      const setAlarm = vi.fn<(deadlineMs: number) => Promise<void>>().mockResolvedValue(undefined)
      const scheduler = new AlarmScheduler({ ttlMs: TTL_MS, setAlarm, sql })
      scheduler.rehydrate()

      const expiredId = tid("aaa")
      const nextId = tid("bbb")
      const nextDeadline = NOW + 5 * 60 * 1000
      await scheduler.schedule(mkEntry(expiredId, NOW - 1000))
      await scheduler.schedule(mkEntry(nextId, nextDeadline))
      setAlarm.mockClear()

      await scheduler.tick(NOW)

      expect(setAlarm).toHaveBeenCalledTimes(1)
      expect(setAlarm).toHaveBeenCalledWith(nextDeadline)
    })
  })

  describe("heap invariant", () => {
    it("returns the minimum deadline regardless of push order", async () => {
      const sql = mkSql([])
      const setAlarm = vi.fn<(deadlineMs: number) => Promise<void>>().mockResolvedValue(undefined)
      const scheduler = new AlarmScheduler({ ttlMs: TTL_MS, setAlarm, sql })
      scheduler.rehydrate()

      const deadlineMinutes = [9, 3, 7, 1, 5, 8, 2, 6, 4] as const
      type PerIdDeadline = { readonly id: TicketId; readonly d: number }
      const entries: readonly PerIdDeadline[] = deadlineMinutes.map((m, i) => ({
        id: tid(`x${String(i).padStart(2, "0")}`),
        d: NOW + m * 60 * 1000,
      }))
      for (const entry of entries) {
        await scheduler.schedule(mkEntry(entry.id, entry.d))
      }

      const min = Math.min(...entries.map((e) => e.d))
      expect(scheduler.earliestMs()).toBe(min)

      // Draining at +∞ must produce ids ordered by ascending deadline.
      const drained = await scheduler.tick(NOW + 100 * 60 * 1000)
      const sortedByDeadline = [...entries].sort((a, b) => a.d - b.d).map((p) => p.id)
      expect(drained).toEqual(sortedByDeadline)
    })
  })
})
