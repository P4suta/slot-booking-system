/**
 * Persistence queries — the SQL surface the DO exposes outside
 * the use case path. Every consumer (HTTP handlers via the DO
 * RPC + the Projector's read model) goes through one of these
 * helpers rather than constructing raw SQL inline.
 *
 * Returns the JSON-safe encoded shape so the worker can hand the
 * result back across the DO RPC boundary unchanged
 * (structuredClone rejects `Temporal.Instant`; see the wire
 * type pivot in ADR-0083 part 1).
 */
import {
  type CustomerHandle,
  type EncodedTicket,
  type Ticket,
  type TicketId,
  TicketSchema,
} from "@booking/core"
import { Schema } from "effect"

export const listTickets = (sql: SqlStorage): readonly EncodedTicket[] => {
  const rows = sql.exec("SELECT payload FROM tickets ORDER BY seq ASC").toArray()
  return rows.map((r) => JSON.parse(r.payload as string) as EncodedTicket)
}

export const getTicketById = (sql: SqlStorage, id: TicketId): EncodedTicket | null => {
  const rows = sql.exec("SELECT payload FROM tickets WHERE id = ? LIMIT 1", id).toArray()
  const r = rows[0]
  if (r === undefined) return null
  return JSON.parse(r.payload as string) as EncodedTicket
}

export const getByHandle = (sql: SqlStorage, handle: CustomerHandle): EncodedTicket | null => {
  const rows = sql
    .exec(
      "SELECT payload FROM tickets WHERE name_kana = ? AND phone_last4 = ? AND state IN ('Waiting','Called','PendingNoShow') LIMIT 1",
      handle.nameKana,
      handle.phoneLast4,
    )
    .toArray()
  const r = rows[0]
  if (r === undefined) return null
  return JSON.parse(r.payload as string) as EncodedTicket
}

/**
 * Decode the active Waiting subset for the EDF deadline read
 * (the wire's `nextReservationDeadline`). The rest of the
 * projection stays in encoded form to keep the RPC payload
 * JSON-safe under structuredClone.
 */
export const listDecodedWaitingTickets = (sql: SqlStorage): Map<TicketId, Ticket> => {
  const rows = sql.exec("SELECT payload FROM tickets WHERE state = 'Waiting'").toArray()
  const m = new Map<TicketId, Ticket>()
  for (const r of rows) {
    const decoded = Schema.decodeUnknownSync(TicketSchema)(JSON.parse(r.payload as string))
    m.set(decoded.id, decoded)
  }
  return m
}

export const lookupActiveIdByHandle = (
  sql: SqlStorage,
  handle: CustomerHandle,
): string | undefined => {
  const row = sql
    .exec(
      "SELECT id FROM tickets WHERE name_kana = ? AND phone_last4 = ? AND state IN ('Waiting','Called','PendingNoShow') LIMIT 1",
      handle.nameKana,
      handle.phoneLast4,
    )
    .toArray()[0]
  return row?.id as string | undefined
}
