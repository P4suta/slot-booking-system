import {
  AggregateNotFoundError,
  ConcurrencyError,
  type NonEmptyReadonlyArray,
  StorageError,
  type Ticket,
  type TicketEvent,
  TicketEventSchema,
  type TicketId,
  TicketRepository,
  TicketSchema,
} from "@booking/core"
import { Effect, Layer, Schema } from "effect"

/**
 * DurableObject-storage-backed adapter for the queue's
 * `TicketRepository`. The DO's local SQLite holds three tables:
 *
 *   - `tickets` — current projection per id (one row, mutated in
 *     place on each transition)
 *   - `ticket_events` — append-only log; `(ticket_id, seq)` UNIQUE
 *     index pins ordering
 *   - `outbox` — relay queue drained into D1 by the alarm
 *
 * `save(id, expected, events, next)` runs as one synchronous batch
 * (`sql.exec` calls inside a single transaction) so partial-success
 * is impossible — the revision check, log append, snapshot upsert,
 * and outbox enqueue all land or none do.
 */
export const DurableObjectTicketRepositoryLive = (sql: SqlStorage) =>
  Layer.succeed(TicketRepository, {
    load: (id: TicketId) => {
      return Effect.gen(function* () {
        const rows = yield* Effect.try({
          try: () =>
            sql.exec("SELECT id, payload, revision FROM tickets WHERE id = ?", id).toArray(),
          catch: (e) => new StorageError({ reason: "load", cause: e }),
        })
        if (rows.length === 0) {
          return yield* Effect.fail(new AggregateNotFoundError({}))
        }
        const row = rows[0]
        if (row === undefined) return yield* Effect.fail(new AggregateNotFoundError({}))
        const decoded = Schema.decodeUnknownSync(TicketSchema)(JSON.parse(row.payload as string))
        return { state: decoded, revision: Number(row.revision ?? 0) }
      })
    },
    save: (
      id: TicketId,
      expected: number,
      events: NonEmptyReadonlyArray<TicketEvent>,
      next: Ticket,
    ) =>
      Effect.try({
        try: () => {
          const cur = sql.exec("SELECT revision FROM tickets WHERE id = ?", id).toArray()
          const current = cur[0] !== undefined ? Number(cur[0].revision ?? 0) : 0
          if (current !== expected) {
            throw new ConcurrencyError({ expected, actual: current })
          }
          for (const ev of events) {
            const encoded = Schema.encodeUnknownSync(TicketEventSchema)(ev)
            sql.exec(
              "INSERT INTO ticket_events (id, ticket_id, seq, type, occurred_at, recorded_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?)",
              ev.id,
              ev.ticketId,
              0,
              ev.type,
              String(ev.occurredAt),
              String(ev.recordedAt),
              JSON.stringify(encoded),
            )
            sql.exec(
              "INSERT OR IGNORE INTO outbox (id, ticket_id, payload) VALUES (?, ?, ?)",
              ev.id,
              ev.ticketId,
              JSON.stringify(encoded),
            )
          }
          const encodedTicket = Schema.encodeUnknownSync(TicketSchema)(next)
          sql.exec(
            "INSERT INTO tickets (id, seq, state, payload, revision) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state, payload = excluded.payload, revision = excluded.revision",
            next.id,
            next.seq,
            next.state,
            JSON.stringify(encodedTicket),
            current + events.length,
          )
        },
        catch: (e) => {
          if (e instanceof ConcurrencyError) return e
          return new StorageError({ reason: "save", cause: e })
        },
      }),
    issue: (_id: TicketId, events: NonEmptyReadonlyArray<TicketEvent>, next: Ticket) =>
      Effect.try({
        try: () => {
          for (const ev of events) {
            const encoded = Schema.encodeUnknownSync(TicketEventSchema)(ev)
            sql.exec(
              "INSERT INTO ticket_events (id, ticket_id, seq, type, occurred_at, recorded_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?)",
              ev.id,
              ev.ticketId,
              0,
              ev.type,
              String(ev.occurredAt),
              String(ev.recordedAt),
              JSON.stringify(encoded),
            )
            sql.exec(
              "INSERT OR IGNORE INTO outbox (id, ticket_id, payload) VALUES (?, ?, ?)",
              ev.id,
              ev.ticketId,
              JSON.stringify(encoded),
            )
          }
          const encodedTicket = Schema.encodeUnknownSync(TicketSchema)(next)
          sql.exec(
            "INSERT INTO tickets (id, seq, state, payload, revision) VALUES (?, ?, ?, ?, ?)",
            next.id,
            next.seq,
            next.state,
            JSON.stringify(encodedTicket),
            events.length,
          )
        },
        catch: (e) => new StorageError({ reason: "issue", cause: e }),
      }),
    nextSeq: () =>
      Effect.try({
        try: () => {
          const rows = sql.exec("SELECT MAX(seq) as max_seq FROM tickets").toArray()
          return Number(rows[0]?.max_seq ?? 0) + 1
        },
        catch: (e) => new StorageError({ reason: "nextSeq", cause: e }),
      }),
    listAll: () =>
      Effect.try({
        try: () => {
          const rows = sql.exec("SELECT payload FROM tickets ORDER BY seq ASC").toArray()
          return rows.map((r) =>
            Schema.decodeUnknownSync(TicketSchema)(JSON.parse(r.payload as string)),
          )
        },
        catch: (e) => new StorageError({ reason: "listAll", cause: e }),
      }),
  })
