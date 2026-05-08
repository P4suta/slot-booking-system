import { Effect, Layer, Ref } from "effect"
import {
  type NonEmptyReadonlyArray,
  TicketRepository,
} from "../../application/ports/EventSourcedRepository.js"
import { AggregateNotFoundError, ConcurrencyError } from "../../domain/errors/Errors.js"
import { applyEvent, type QueueSnapshot } from "../../domain/queue/projection.js"
import type { Ticket } from "../../domain/queue/Ticket.js"
import type { TicketEvent } from "../../domain/queue/TicketEvent.js"
import type { TicketId } from "../../domain/types/EntityId.js"

type Row = {
  readonly state: Ticket
  readonly revision: number
}

/**
 * In-memory adapter for the queue's `TicketRepository`. Backed by a
 * single `Ref<Map<TicketId, Row>>` plus a monotonic seq counter and
 * an append-only event log; used by domain unit tests. The
 * Cloudflare-DurableObject adapter writes the same contract on top
 * of `ctx.storage.sql`.
 */
/**
 * Default snapshot cadence — matches the DO adapter so the in-memory
 * mirror exercises the same load-replay path under test. Lifted to a
 * factory parameter so tests can pin a smaller K to drive the
 * snapshot boundary inside a realistic ticket lifecycle.
 */
export const DEFAULT_SNAPSHOT_INTERVAL = 200

/**
 * Layer factory parametrised by the snapshot interval. Production
 * uses {@link InMemoryTicketRepositoryLive} (K=200); tests that need
 * to assert the snapshot path is exercised pass a small K (e.g. 2)
 * so a 3-event Issue / Call / Served lifecycle reaches a snapshot
 * boundary.
 */
export const makeInMemoryTicketRepositoryLive = (
  snapshotInterval: number = DEFAULT_SNAPSHOT_INTERVAL,
) =>
  Layer.effect(
    TicketRepository,
    Effect.gen(function* () {
      const store = yield* Ref.make<Map<TicketId, Row>>(new Map())
      const seq = yield* Ref.make(0)
      const events = yield* Ref.make<readonly TicketEvent[]>([])
      const snapshots = yield* Ref.make<Map<TicketId, Row>>(new Map())
      return {
        load: (id: TicketId) =>
          Effect.gen(function* () {
            // Snapshot path mirrors the DO adapter: the snapshot row
            // anchors the replay start; the delta tail in the event
            // log brings the state forward to the current revision.
            const snaps = yield* Ref.get(snapshots)
            const snap = snaps.get(id)
            if (snap !== undefined) {
              const allEvents = yield* Ref.get(events)
              const ticketEvents = allEvents.filter((e) => e.ticketId === id)
              const delta = ticketEvents.slice(snap.revision)
              if (delta.length === 0) {
                return { state: snap.state, revision: snap.revision }
              }
              let acc: QueueSnapshot = {
                tickets: new Map([[id, snap.state]]),
              }
              for (const ev of delta) {
                acc = applyEvent(acc, ev)
              }
              const next = acc.tickets.get(id)
              /* v8 ignore next */
              if (next === undefined) {
                return yield* Effect.fail(new AggregateNotFoundError({}))
              }
              return { state: next, revision: snap.revision + delta.length }
            }
            const m = yield* Ref.get(store)
            const row = m.get(id)
            if (row === undefined) {
              return yield* Effect.fail(new AggregateNotFoundError({}))
            }
            return { state: row.state, revision: row.revision }
          }),
        save: (
          id: TicketId,
          expected: number,
          evs: NonEmptyReadonlyArray<TicketEvent>,
          next: Ticket,
        ) =>
          Effect.gen(function* () {
            const m = yield* Ref.get(store)
            const row = m.get(id)
            if (row?.revision !== expected) {
              return yield* Effect.fail(
                new ConcurrencyError({ expected, actual: row?.revision ?? 0 }),
              )
            }
            const nextRevision = row.revision + evs.length
            const updated = new Map(m)
            updated.set(id, { state: next, revision: nextRevision })
            yield* Ref.set(store, updated)
            yield* Ref.update(events, (xs) => xs.concat(...evs))
            if (nextRevision % snapshotInterval === 0) {
              yield* Ref.update(snapshots, (snaps) => {
                const copy = new Map(snaps)
                copy.set(id, { state: next, revision: nextRevision })
                return copy
              })
            }
          }),
        issue: (_id: TicketId, evs: NonEmptyReadonlyArray<TicketEvent>, next: Ticket) =>
          Effect.gen(function* () {
            const m = yield* Ref.get(store)
            if (m.has(next.id)) {
              return yield* Effect.fail(new ConcurrencyError({ expected: 0, actual: 1 }))
            }
            const nextRevision = evs.length
            const updated = new Map(m)
            updated.set(next.id, { state: next, revision: nextRevision })
            yield* Ref.set(store, updated)
            yield* Ref.update(events, (xs) => xs.concat(...evs))
            if (nextRevision % snapshotInterval === 0) {
              yield* Ref.update(snapshots, (snaps) => {
                const copy = new Map(snaps)
                copy.set(next.id, { state: next, revision: nextRevision })
                return copy
              })
            }
          }),
        nextSeq: () =>
          Ref.modify(seq, (n) => {
            const next = n + 1
            return [next, next] as const
          }),
        listAll: () =>
          Ref.get(store).pipe(Effect.map((m) => Array.from(m.values()).map((r) => r.state))),
      }
    }),
  )

export const InMemoryTicketRepositoryLive = makeInMemoryTicketRepositoryLive()
