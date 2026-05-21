import { type Ticket, type TicketEvent, TicketEventSchema, TicketSchema } from "@booking/core"
import { Schema } from "effect"

/**
 * Single source of truth for the JSON-on-the-wire ↔ domain
 * conversion that backs the DurableObject SQLite `payload TEXT`
 * columns. `Schema.fromJsonString(X)` composes:
 *
 *   - encode direction: `Schema.encodeUnknownSync(X)` then
 *     `JSON.stringify`
 *   - decode direction: `JSON.parse` then
 *     `Schema.decodeUnknownSync(X)`
 *
 * Every adapter / DO method that touches `tickets.payload`,
 * `ticket_events.payload`, `aggregate_snapshots.payload`, or
 * `outbox.payload` MUST go through this module so the
 * Schema-mediated boundary regression (ADR-0019 / ADR-0059)
 * cannot reopen. The `JSON.parse` / `JSON.stringify` lint gate
 * (`.dependency-cruiser.cjs`) restricts those primitives to
 * codec modules + structured-log emit sites.
 */

const TicketPayloadSchema = Schema.fromJsonString(TicketSchema)
const TicketEventPayloadSchema = Schema.fromJsonString(TicketEventSchema)

const encodeTicketPayloadSync = Schema.encodeUnknownSync(TicketPayloadSchema)
const decodeTicketPayloadSync = Schema.decodeUnknownSync(TicketPayloadSchema)
const encodeEventPayloadSync = Schema.encodeUnknownSync(TicketEventPayloadSchema)
const decodeEventPayloadSync = Schema.decodeUnknownSync(TicketEventPayloadSchema)

/** Encode a Ticket into the JSON string stored in `tickets.payload` / `aggregate_snapshots.payload`. */
export const encodeTicketRowPayload = (ticket: Ticket): string => encodeTicketPayloadSync(ticket)

/** Encode a TicketEvent into the JSON string stored in `ticket_events.payload` / `outbox.payload`. */
export const encodeEventRowPayload = (event: TicketEvent): string => encodeEventPayloadSync(event)

/** Decode a ticket row's `payload` column into the domain Ticket (Schema-validated). */
export const decodeTicketRowPayload = (payload: unknown): Ticket => decodeTicketPayloadSync(payload)

/** Decode an event row's `payload` column into the domain TicketEvent (Schema-validated). */
export const decodeEventRowPayload = (payload: unknown): TicketEvent =>
  decodeEventPayloadSync(payload)

/**
 * JSON-safe encoded shape of a Ticket. Mirrors the
 * structuredClone-compatible wire form (`Temporal.Instant`
 * rendered as ISO strings, etc.) that the DO ↔ worker boundary
 * requires.
 */
export type EncodedTicket = (typeof TicketSchema)["Encoded"]

/**
 * Decode a ticket row's `payload` column into the
 * `Schema.Encoded` shape *without* running the value-level
 * Schema decoder. Callers that hand the result back across the
 * DO RPC boundary (which structuredClones every argument) need
 * the JSON-safe shape — running `decodeTicketRowPayload` would
 * eagerly construct `Temporal.Instant` instances that the clone
 * rejects.
 *
 * The shape contract is owned by `TicketSchema`: any encode-side
 * change there propagates here through the `Schema.Schema.Encoded`
 * type alias.
 */
export const decodeTicketRowToEncoded = (payload: unknown): EncodedTicket => {
  if (typeof payload !== "string") {
    throw new TypeError(`ticket row payload must be a string (got ${typeof payload})`)
  }
  // codec-scoped JSON.parse — the lint gate restricts this primitive
  // to codec/ modules + structured-log emit sites.
  return JSON.parse(payload) as EncodedTicket
}
