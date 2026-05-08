import { Effect, Layer, Ref } from "effect"
import {
  type NonEmptyReadonlyArray,
  TicketRepository,
} from "../../application/ports/EventSourcedRepository.js"
import { AggregateNotFoundError, ConcurrencyError } from "../../domain/errors/Errors.js"
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
export const InMemoryTicketRepositoryLive = Layer.effect(
  TicketRepository,
  Effect.gen(function* () {
    const store = yield* Ref.make<Map<TicketId, Row>>(new Map())
    const seq = yield* Ref.make(0)
    const events = yield* Ref.make<readonly TicketEvent[]>([])
    return {
      load: (id: TicketId) =>
        Effect.gen(function* () {
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
          const updated = new Map(m)
          updated.set(id, { state: next, revision: row.revision + evs.length })
          yield* Ref.set(store, updated)
          yield* Ref.update(events, (xs) => xs.concat(...evs))
        }),
      issue: (_id: TicketId, evs: NonEmptyReadonlyArray<TicketEvent>, next: Ticket) =>
        Effect.gen(function* () {
          const m = yield* Ref.get(store)
          if (m.has(next.id)) {
            return yield* Effect.fail(new ConcurrencyError({ expected: 0, actual: 1 }))
          }
          const updated = new Map(m)
          updated.set(next.id, { state: next, revision: evs.length })
          yield* Ref.set(store, updated)
          yield* Ref.update(events, (xs) => xs.concat(...evs))
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
