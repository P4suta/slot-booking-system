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
 * single `Ref<Map<TicketId, Row>>` plus a monotonic seq counter,
 * mirroring the slot-graph's `InMemoryEventSourcedRepositoryLive`
 * pattern. Used directly by domain unit tests; the
 * Cloudflare-DurableObject adapter (Phase 2) writes the same
 * contract on top of `ctx.storage.sql`.
 */
export const InMemoryTicketRepositoryLive = Layer.effect(
  TicketRepository,
  Effect.gen(function* () {
    const store = yield* Ref.make<Map<TicketId, Row>>(new Map())
    const seq = yield* Ref.make(0)
    const events = yield* Ref.make<readonly TicketEvent[]>([])
    return {
      load: (id: TicketId) =>
        Ref.get(store).pipe(
          Effect.flatMap((m) => {
            const row = m.get(id)
            return row === undefined
              ? Effect.fail(new AggregateNotFoundError({}))
              : Effect.succeed({ state: row.state, revision: row.revision })
          }),
        ),
      save: (
        id: TicketId,
        expected: number,
        evs: NonEmptyReadonlyArray<TicketEvent>,
        next: Ticket,
      ) =>
        Ref.modify(store, (m) => {
          const row = m.get(id)
          if (row === undefined || row.revision !== expected) {
            return [
              Effect.fail(
                new ConcurrencyError({
                  expected,
                  actual: row?.revision ?? 0,
                }),
              ),
              m,
            ] as const
          }
          const updated = new Map(m)
          updated.set(id, { state: next, revision: row.revision + evs.length })
          return [Effect.void, updated] as const
        }).pipe(
          Effect.flatten,
          Effect.tap(() => Ref.update(events, (xs) => xs.concat(...evs))),
        ),
      issue: (id: TicketId, evs: NonEmptyReadonlyArray<TicketEvent>, next: Ticket) =>
        Ref.modify(store, (m) => {
          if (m.has(id)) {
            return [Effect.fail(new ConcurrencyError({ expected: 0, actual: 1 })), m] as const
          }
          const updated = new Map(m)
          updated.set(id, { state: next, revision: evs.length })
          return [Effect.void, updated] as const
        }).pipe(
          Effect.flatten,
          Effect.tap(() => Ref.update(events, (xs) => xs.concat(...evs))),
        ),
      nextSeq: () => Ref.modify(seq, (n) => [n + 1, n + 1] as const),
      listAll: () =>
        Ref.get(store).pipe(Effect.map((m) => Array.from(m.values()).map((r) => r.state))),
    }
  }),
)
