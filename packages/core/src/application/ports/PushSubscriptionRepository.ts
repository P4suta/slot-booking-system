import { Context, type Effect } from "effect"
import type { StorageError } from "../../domain/errors/Errors.js"
import type { TicketId } from "../../domain/types/EntityId.js"

/**
 * One subscription row in the DurableObject's `push_subscriptions`
 * table. Ticket-scoped (ADR-0074): the table carries `ticket_id`
 * as the only customer-identifying column. Payloads are anonymous
 * (`{ v, kind, displaySeq }`) and the endpoint reaping policy
 * lives below.
 */
export type PushSubscriptionRecord = {
  readonly endpoint: string
  readonly p256dh: string
  readonly auth: string
}

/**
 * Persistence port for the Web Push subscription table (ADR-0073 /
 * ADR-0074). Split from `TicketRepository` because the aggregate
 * boundary is different: subscriptions are bound to a specific
 * `(ticket_id, endpoint)` pair and have their own lifecycle (one
 * row per browser, reaped on terminal transition or push-service
 * 404 / 410).
 *
 * Contract:
 *
 *   1. `register(ticketId, sub)` is idempotent on the
 *      `(ticket_id, endpoint)` pair. Re-registering the same device
 *      refreshes `p256dh` / `auth` / `created_at`.
 *   2. `unregister(ticketId, endpoint)` is also idempotent — a
 *      missing row is `void` success, not an error.
 *   3. `list(ticketId)` returns every subscription for the ticket.
 *   4. `reapByTicket(ticketId)` removes all rows for a ticket. The
 *      `dispatch` hook calls this immediately after every action
 *      that lands the ticket in a terminal state (Served / NoShow
 *      / Cancelled), so the table holds zero stale rows for
 *      finished customers.
 *   5. `deleteByEndpoint(ticketId, endpoint)` removes a single row
 *      when the push service signals the endpoint is gone (the
 *      404 / 410 path inside `fanOutPush`).
 *
 * The implementation MUST satisfy ADR-0074 anonymity — no PII
 * (`name_kana`, `phone_last4`, IP, UA) belongs in the table,
 * only the ticket-scoped opaque triple.
 */
export class PushSubscriptionRepository extends Context.Service<
  PushSubscriptionRepository,
  {
    readonly register: (
      ticketId: TicketId,
      subscription: PushSubscriptionRecord,
    ) => Effect.Effect<void, StorageError>
    readonly unregister: (ticketId: TicketId, endpoint: string) => Effect.Effect<void, StorageError>
    readonly list: (
      ticketId: TicketId,
    ) => Effect.Effect<readonly PushSubscriptionRecord[], StorageError>
    readonly reapByTicket: (ticketId: TicketId) => Effect.Effect<void, StorageError>
    readonly deleteByEndpoint: (
      ticketId: TicketId,
      endpoint: string,
    ) => Effect.Effect<void, StorageError>
  }
>()("@booking/core/PushSubscriptionRepository") {}
