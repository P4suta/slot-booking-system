import {
  type PushSubscriptionRecord,
  PushSubscriptionRepository,
  StorageError,
  type TicketId,
} from "@booking/core"
import { Effect, Layer } from "effect"

/**
 * DurableObject-storage-backed adapter for the Web Push
 * subscription port (ADR-0073 / ADR-0074). The DO's local SQLite
 * carries the `push_subscriptions` table — the ticket-scoped,
 * payload-anonymous row triple per ADR-0074.
 *
 * Two surfaces:
 *
 *   - **`DurableObjectPushSubscriptionRepositoryLive(sql)`** is the
 *     `Effect.Layer` that satisfies `PushSubscriptionRepository`
 *     for application-layer callers (use cases, alarm sweep
 *     orchestrators run through `Effect.runPromise`).
 *   - **`makePushSubscriptionStore(sql)`** is the same set of
 *     operations exposed *synchronously* so the DO's Promise-style
 *     methods (`registerPushSubscription`, `unregisterPushSubscription`,
 *     `listPushSubscriptions`, `reapTerminalSubscriptions`) can call
 *     into the single SQL surface without spinning up an Effect
 *     runtime per call. The Layer above is a thin `Effect.try`
 *     wrap over this store.
 *
 * The single-writer DO guarantee (ADR-0053) lets every method run
 * as a raw `sql.exec(...)` without interleaving inside a method.
 */

export type PushSubscriptionStore = {
  readonly register: (ticketId: TicketId, subscription: PushSubscriptionRecord) => void
  readonly unregister: (ticketId: TicketId, endpoint: string) => void
  readonly list: (ticketId: TicketId) => readonly PushSubscriptionRecord[]
  readonly reapByTicket: (ticketId: TicketId) => void
  readonly deleteByEndpoint: (ticketId: TicketId, endpoint: string) => void
}

/** Build the synchronous DO-backed store; used by both the Layer and DO sync methods. */
export const makePushSubscriptionStore = (sql: SqlStorage): PushSubscriptionStore => ({
  register: (ticketId, subscription) => {
    sql.exec(
      `INSERT INTO push_subscriptions (ticket_id, endpoint, p256dh, auth)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(ticket_id, endpoint) DO UPDATE SET
         p256dh = excluded.p256dh,
         auth   = excluded.auth,
         created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
      ticketId,
      subscription.endpoint,
      subscription.p256dh,
      subscription.auth,
    )
  },
  unregister: (ticketId, endpoint) => {
    sql.exec(
      "DELETE FROM push_subscriptions WHERE ticket_id = ? AND endpoint = ?",
      ticketId,
      endpoint,
    )
  },
  list: (ticketId) => {
    const rows = sql
      .exec("SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE ticket_id = ?", ticketId)
      .toArray()
    return rows.map((r) => ({
      endpoint: r.endpoint as string,
      p256dh: r.p256dh as string,
      auth: r.auth as string,
    }))
  },
  reapByTicket: (ticketId) => {
    sql.exec("DELETE FROM push_subscriptions WHERE ticket_id = ?", ticketId)
  },
  deleteByEndpoint: (ticketId, endpoint) => {
    sql.exec(
      "DELETE FROM push_subscriptions WHERE ticket_id = ? AND endpoint = ?",
      ticketId,
      endpoint,
    )
  },
})

export const DurableObjectPushSubscriptionRepositoryLive = (sql: SqlStorage) => {
  const store = makePushSubscriptionStore(sql)
  return Layer.succeed(PushSubscriptionRepository, {
    register: (ticketId, subscription) =>
      Effect.try({
        try: () => {
          store.register(ticketId, subscription)
        },
        catch: (e) => new StorageError({ reason: "pushSubscription.register", cause: e }),
      }),
    unregister: (ticketId, endpoint) =>
      Effect.try({
        try: () => {
          store.unregister(ticketId, endpoint)
        },
        catch: (e) => new StorageError({ reason: "pushSubscription.unregister", cause: e }),
      }),
    list: (ticketId) =>
      Effect.try({
        try: () => store.list(ticketId),
        catch: (e) => new StorageError({ reason: "pushSubscription.list", cause: e }),
      }),
    reapByTicket: (ticketId) =>
      Effect.try({
        try: () => {
          store.reapByTicket(ticketId)
        },
        catch: (e) => new StorageError({ reason: "pushSubscription.reapByTicket", cause: e }),
      }),
    deleteByEndpoint: (ticketId, endpoint) =>
      Effect.try({
        try: () => {
          store.deleteByEndpoint(ticketId, endpoint)
        },
        catch: (e) => new StorageError({ reason: "pushSubscription.deleteByEndpoint", cause: e }),
      }),
  })
}
