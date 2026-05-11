/**
 * Wire types — the JSON-safe shapes the server emits across the DO
 * RPC + WebSocket boundaries and the client consumes. The decoded
 * variants live in `domain/queue/Ticket.ts` (Temporal.Instant +
 * branded primitives); this module exposes their post-encoding
 * counterparts (ISO-8601 strings + plain primitives) so downstream
 * consumers can rely on a single source of truth.
 *
 * The encoded shape is **hand-written** rather than derived as
 * `Schema.Codec.Encoded<typeof TicketSchema>` because the indexed
 * lookup over a `Schema.Union<readonly [Schema.Struct<…>, …]>` is
 * deeply nested and degrades type-resolution at the consumer side
 * (the `typescript-eslint` parser hits its bailout and reports the
 * resolved field as `'error' type that acts as 'any'`). The
 * structural alias here resolves identically at every consumer.
 *
 * Schema-derived equivalence is pinned by a type-level assertion in
 * `test/projection/wire.test.ts` — a divergence between the encoded
 * union and `Schema.Codec.Encoded<typeof TicketSchema>` fails the
 * test at type-check time.
 */
import { Schema } from "effect"
import { type Ticket, TicketSchema } from "../domain/queue/Ticket.js"

type EncodedActor = "customer" | "staff" | "system"
type EncodedLane = "walkIn" | "priority" | "reservation"

type EncodedTicketCommon = {
  readonly id: string
  readonly seq: number
  readonly lane: EncodedLane
  readonly displaySeq: number
  readonly nameKana: string
  readonly phoneLast4: string
  readonly freeText: string | null
  readonly issuedAt: string
  readonly appointmentAt: string | null
  readonly checkedInAt: string | null
}

export type EncodedWaitingTicket = EncodedTicketCommon & {
  readonly state: "Waiting"
}

export type EncodedCalledTicket = EncodedTicketCommon & {
  readonly state: "Called"
  readonly calledAt: string
  readonly calledBy: EncodedActor
}

export type EncodedPendingNoShowTicket = EncodedTicketCommon & {
  readonly state: "PendingNoShow"
  readonly calledAt: string
  readonly calledBy: EncodedActor
  readonly markedAt: string
  readonly markedBy: EncodedActor
}

export type EncodedServedTicket = EncodedTicketCommon & {
  readonly state: "Served"
  readonly calledAt: string
  readonly calledBy: EncodedActor
  readonly servedAt: string
  readonly servedBy: EncodedActor
}

export type EncodedNoShowTicket = EncodedTicketCommon & {
  readonly state: "NoShow"
  readonly calledAt: string
  readonly calledBy: EncodedActor
  readonly markedAt: string
  readonly markedBy: EncodedActor
}

export type EncodedCancelledTicket = EncodedTicketCommon & {
  readonly state: "Cancelled"
  readonly cancelledAt: string
  readonly cancelledBy: EncodedActor
  readonly reason: string
}

export type EncodedTicket =
  | EncodedWaitingTicket
  | EncodedCalledTicket
  | EncodedPendingNoShowTicket
  | EncodedServedTicket
  | EncodedNoShowTicket
  | EncodedCancelledTicket

/**
 * Encode a decoded {@link Ticket} into its JSON-safe wire shape. The
 * server passes encoded tickets across the DO RPC + WebSocket
 * boundaries (structuredClone rejects `Temporal.Instant`, so the
 * decoded variant cannot cross).
 */
export const encodeTicket = (t: Ticket): EncodedTicket => Schema.encodeUnknownSync(TicketSchema)(t)
