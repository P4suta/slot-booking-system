import {
  AggregateNotFoundError,
  applyEvent,
  type BatchedSave,
  ConcurrencyError,
  empty as emptySnapshot,
  type NonEmptyReadonlyArray,
  type QueueSnapshot,
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
 * Aggregate snapshots emit every K events so `load(id)` can hydrate
 * from the snapshot + a small delta tail rather than replaying the
 * whole history each time. The constant matches the AWS Aurora
 * conservative snapshot cadence (k=200 events ≈ 1 day at production
 * volume) — large enough that snapshot writes amortise, small enough
 * that worst-case replay stays bounded.
 */
const SNAPSHOT_INTERVAL = 200

const SNAPSHOT_UPSERT_SQL = `INSERT INTO aggregate_snapshots (ticket_id, revision, payload)
VALUES (?, ?, ?)
ON CONFLICT(ticket_id) DO UPDATE SET
  revision = excluded.revision,
  payload = excluded.payload,
  created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`

const TICKET_INSERT_SQL = `INSERT INTO tickets (
  id, seq, state, name_kana, phone_last4, free_text, issued_at,
  called_at, served_at, cancelled_at, marked_at,
  reason, cancelled_by, called_by, served_by, marked_by,
  payload, revision
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  state = excluded.state,
  called_at = excluded.called_at,
  served_at = excluded.served_at,
  cancelled_at = excluded.cancelled_at,
  marked_at = excluded.marked_at,
  reason = excluded.reason,
  cancelled_by = excluded.cancelled_by,
  called_by = excluded.called_by,
  served_by = excluded.served_by,
  marked_by = excluded.marked_by,
  payload = excluded.payload,
  revision = excluded.revision,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`

const ticketColumns = (
  next: Ticket,
  encodedTicket: unknown,
  revision: number,
): readonly unknown[] => [
  next.id,
  next.seq,
  next.state,
  next.nameKana,
  next.phoneLast4,
  next.freeText,
  String(next.issuedAt),
  "calledAt" in next ? String(next.calledAt) : null,
  "servedAt" in next ? String(next.servedAt) : null,
  "cancelledAt" in next ? String(next.cancelledAt) : null,
  "markedAt" in next ? String(next.markedAt) : null,
  "reason" in next ? next.reason : null,
  "cancelledBy" in next ? next.cancelledBy : null,
  "calledBy" in next ? next.calledBy : null,
  "servedBy" in next ? next.servedBy : null,
  "markedBy" in next ? next.markedBy : null,
  JSON.stringify(encodedTicket),
  revision,
]

/**
 * DurableObject-storage-backed adapter for the queue's
 * `TicketRepository`. The DO's local SQLite holds four tables:
 *
 *   - `ticket_events` — append-only event log; canonical truth.
 *     `(ticket_id, seq)` UNIQUE index pins ordering.
 *   - `aggregate_snapshots` — load accelerator emitted every K
 *     events; one row per ticket id, upserted in place.
 *   - `tickets` — read-side projection materialized view.
 *     Rebuilt as `applyEvent` folds each emitted event; every
 *     query-side caller (listAll, the operator dashboard) reads
 *     from here so the projection stays cheap.
 *   - `outbox` — relay queue drained into D1 by the alarm.
 *
 * `save(id, expected, events, next)` runs as one synchronous batch
 * (`sql.exec` calls inside a single transaction) so partial-success
 * is impossible — the revision check, event log append, snapshot
 * upsert, projection refresh, and outbox enqueue all land or none do.
 */
export const DurableObjectTicketRepositoryLive = (sql: SqlStorage) =>
  Layer.succeed(TicketRepository, {
    load: (id: TicketId) => {
      return Effect.gen(function* () {
        // Aggregate-snapshot path: latest snapshot anchors the replay
        // start; the delta tail in `ticket_events` brings the state
        // forward to the current revision. Falls through to the
        // tickets row when no snapshot has been emitted yet (the
        // first SNAPSHOT_INTERVAL events) so the migration does not
        // strand pre-existing aggregates.
        const snapRows = yield* Effect.try({
          try: () =>
            sql
              .exec("SELECT revision, payload FROM aggregate_snapshots WHERE ticket_id = ?", id)
              .toArray(),
          catch: (e) => new StorageError({ reason: "load.snapshot", cause: e }),
        })
        let baseTicket: Ticket | null = null
        let baseRevision = 0
        const snap = snapRows[0]
        if (snap !== undefined) {
          baseRevision = Number(snap.revision ?? 0)
          baseTicket = yield* Effect.try({
            try: () => Schema.decodeUnknownSync(TicketSchema)(JSON.parse(snap.payload as string)),
            catch: (e) => new StorageError({ reason: "decode.snapshot", cause: e }),
          })
        }
        const evRows = yield* Effect.try({
          try: () =>
            sql
              .exec(
                "SELECT payload FROM ticket_events WHERE ticket_id = ? AND seq > ? ORDER BY seq ASC",
                id,
                baseRevision,
              )
              .toArray(),
          catch: (e) => new StorageError({ reason: "load.events", cause: e }),
        })
        if (baseTicket !== null) {
          let acc: QueueSnapshot = { tickets: new Map([[id, baseTicket]]) }
          for (const r of evRows) {
            const ev = yield* Effect.try({
              try: () =>
                Schema.decodeUnknownSync(TicketEventSchema)(JSON.parse(r.payload as string)),
              catch: (e) => new StorageError({ reason: "decode.event", cause: e }),
            })
            acc = applyEvent(acc, ev)
          }
          const next = acc.tickets.get(id)
          /* v8 ignore next */
          if (next === undefined) return yield* Effect.fail(new AggregateNotFoundError({}))
          return { state: next, revision: baseRevision + evRows.length }
        }
        if (evRows.length > 0) {
          let acc: QueueSnapshot = emptySnapshot
          for (const r of evRows) {
            const ev = yield* Effect.try({
              try: () =>
                Schema.decodeUnknownSync(TicketEventSchema)(JSON.parse(r.payload as string)),
              catch: (e) => new StorageError({ reason: "decode.event", cause: e }),
            })
            acc = applyEvent(acc, ev)
          }
          const next = acc.tickets.get(id)
          /* v8 ignore next */
          if (next === undefined) return yield* Effect.fail(new AggregateNotFoundError({}))
          return { state: next, revision: evRows.length }
        }
        // Pre-existing aggregates with neither snapshot nor events
        // (legacy seed data) still resolve via the projection table
        // until C17 demotes it to read-only.
        const rows = yield* Effect.try({
          try: () => sql.exec("SELECT payload, revision FROM tickets WHERE id = ?", id).toArray(),
          catch: (e) => new StorageError({ reason: "load", cause: e }),
        })
        const row = rows[0]
        if (row === undefined) return yield* Effect.fail(new AggregateNotFoundError({}))
        const decoded = yield* Effect.try({
          try: () => Schema.decodeUnknownSync(TicketSchema)(JSON.parse(row.payload as string)),
          catch: (e) => new StorageError({ reason: "decode.ticket", cause: e }),
        })
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
          let seq = current
          for (const ev of events) {
            seq += 1
            const encoded = Schema.encodeUnknownSync(TicketEventSchema)(ev)
            sql.exec(
              "INSERT INTO ticket_events (id, ticket_id, seq, type, occurred_at, recorded_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?)",
              ev.id,
              ev.ticketId,
              seq,
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
          const nextRevision = current + events.length
          sql.exec(TICKET_INSERT_SQL, ...ticketColumns(next, encodedTicket, nextRevision))
          if (nextRevision % SNAPSHOT_INTERVAL === 0) {
            sql.exec(SNAPSHOT_UPSERT_SQL, id, nextRevision, JSON.stringify(encodedTicket))
          }
        },
        catch: (e) => {
          if (e instanceof ConcurrencyError) return e
          return new StorageError({ reason: "save", cause: e })
        },
      }),
    issue: (_id: TicketId, events: NonEmptyReadonlyArray<TicketEvent>, next: Ticket) =>
      Effect.try({
        try: () => {
          let seq = 0
          for (const ev of events) {
            seq += 1
            const encoded = Schema.encodeUnknownSync(TicketEventSchema)(ev)
            sql.exec(
              "INSERT INTO ticket_events (id, ticket_id, seq, type, occurred_at, recorded_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?)",
              ev.id,
              ev.ticketId,
              seq,
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
          const nextRevision = events.length
          sql.exec(TICKET_INSERT_SQL, ...ticketColumns(next, encodedTicket, nextRevision))
          if (nextRevision % SNAPSHOT_INTERVAL === 0) {
            sql.exec(SNAPSHOT_UPSERT_SQL, next.id, nextRevision, JSON.stringify(encodedTicket))
          }
        },
        catch: (e) => new StorageError({ reason: "issue", cause: e }),
      }),
    saveBatch: (updates: NonEmptyReadonlyArray<BatchedSave>) =>
      Effect.try({
        try: () => {
          // Two-phase: verify every revision first so a single
          // mismatched member rolls the whole batch back without
          // partial writes. The DO single-writer guarantee makes the
          // verify→commit race-free; we still scan inside the same
          // synchronous batch so the SqlStorage transaction is the
          // unit of atomicity.
          for (const u of updates) {
            const cur = sql.exec("SELECT revision FROM tickets WHERE id = ?", u.id).toArray()
            const current = cur[0] !== undefined ? Number(cur[0].revision ?? 0) : 0
            if (current !== u.expected) {
              throw new ConcurrencyError({ expected: u.expected, actual: current })
            }
          }
          for (const u of updates) {
            let seq = u.expected
            for (const ev of u.events) {
              seq += 1
              const encoded = Schema.encodeUnknownSync(TicketEventSchema)(ev)
              sql.exec(
                "INSERT INTO ticket_events (id, ticket_id, seq, type, occurred_at, recorded_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?)",
                ev.id,
                ev.ticketId,
                seq,
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
            const encodedTicket = Schema.encodeUnknownSync(TicketSchema)(u.next)
            const nextRevision = u.expected + u.events.length
            sql.exec(TICKET_INSERT_SQL, ...ticketColumns(u.next, encodedTicket, nextRevision))
            if (nextRevision % SNAPSHOT_INTERVAL === 0) {
              sql.exec(SNAPSHOT_UPSERT_SQL, u.id, nextRevision, JSON.stringify(encodedTicket))
            }
          }
        },
        catch: (e) => {
          if (e instanceof ConcurrencyError) return e
          return new StorageError({ reason: "saveBatch", cause: e })
        },
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
