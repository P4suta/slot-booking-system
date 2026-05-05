import { type BookingEvent, BookingEventSchema, EventStore } from "@booking/core"
import { Effect, Layer, Schema } from "effect"
import type { DurableStorage } from "./DurableObjectRepositoryLive.js"

/**
 * Append-only event log persisted in the DurableObject's storage.
 *
 * Each event is keyed `e:<bookingId>:<seq>` where `seq` is a per-
 * aggregate monotonic counter. The current `seq` per booking is
 * stored at `s:<bookingId>` so a fresh append can read-and-bump
 * inside one transaction without scanning the existing log.
 *
 * The "outbox" is the same log: a periodic `alarm()` selects every
 * row with `key > o:<lastSent>` and pushes to D1, then writes
 * `o:<lastSent> = max(seq)`. Idempotent at-least-once per ADR-0006.
 */

const eventKey = (bookingId: string, seq: number): string =>
  `e:${bookingId}:${seq.toString().padStart(10, "0")}`

const seqKey = (bookingId: string): string => `s:${bookingId}`

const encodeEvent = Schema.encodeSync(BookingEventSchema)
const decodeEvent = Schema.decodeUnknownEither(BookingEventSchema)

export const makeDurableObjectEventStore = (storage: DurableStorage): Layer.Layer<EventStore> =>
  Layer.succeed(
    EventStore,
    EventStore.of({
      appendEvent: (event) =>
        Effect.promise(() =>
          storage.transaction(async (txn) => {
            const current = (await txn.get<number>(seqKey(event.bookingId))) ?? 0
            const next = current + 1
            await txn.put({
              [seqKey(event.bookingId)]: next,
              [eventKey(event.bookingId, next)]: encodeEvent(event),
            })
          }),
        ),
    }),
  )

/** Read every event in the log, in (bookingId, seq) ascending order. */
export const loadAllEvents = async (storage: DurableStorage): Promise<readonly BookingEvent[]> => {
  const entries = await storage.list<unknown>({ prefix: "e:" })
  // Map insertion order matches lexicographic key order in DO storage,
  // and the zero-padded seq guarantees that order matches numeric
  // (bookingId, seq) order.
  const out: BookingEvent[] = []
  for (const [, raw] of entries) {
    const decoded = decodeEvent(raw)
    if (decoded._tag === "Right") out.push(decoded.right)
  }
  return out
}
