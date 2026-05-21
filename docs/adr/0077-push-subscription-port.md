# ADR-0077: Push subscription as a separate aggregate port

- Status: accepted
- Date: 2026-05-22
- Refines: ADR-0073 (Web Push channel), ADR-0074 (push subscription anonymity)
- Tags: architecture · durable-object · ports

## Context

ADR-0073 introduced Web Push (VAPID / RFC 8291 aes128gcm) as
the background notification transport, and ADR-0074 pinned the
anonymity contract — subscriptions are ticket-scoped, payloads
carry only `{ v, kind, displaySeq }`, and rows reap on terminal
ticket transition.

The first cut of the schema landed the four operations as raw
`this.sql.exec(...)` calls inside `QueueShop.ts` (register /
unregister / list / reapByTicket / deleteByEndpoint). Two
problems emerged once the persistence-codec refactor (ADR-0076's
sibling — the JSON.parse lint gate) tightened the rules around
storage SQL:

1. The `push_subscriptions` SQL lived alongside the much larger
   `tickets` / `ticket_events` SQL, with no module-level boundary
   between them. A future reader auditing "where does push data
   go" had to scan QueueShop top-to-bottom.
2. Application-layer callers (the alarm sweep's Tick 2,
   future Effect-based use cases) had no `Effect`-typed surface
   for push operations; they were forced to inline raw SQL or
   go through opaque DO methods.

## Decision

Add a `PushSubscriptionRepository` `Context.Service` port at
`packages/core/src/application/ports/PushSubscriptionRepository.ts`.
The port mirrors `TicketRepository`'s shape (ADR-0020) — five
`Effect`-returning methods (`register`, `unregister`, `list`,
`reapByTicket`, `deleteByEndpoint`) — and is provisioned by a
new adapter in `apps/default/src/server/adapters/DurableObjectPushSubscriptionRepositoryLive.ts`.

The adapter exports two surfaces from the same module:

- `DurableObjectPushSubscriptionRepositoryLive(sql)` — the
  `Effect.Layer` satisfying the port. Used by application-
  layer / Effect-internal callers (alarm sweep, future use
  cases).
- `makePushSubscriptionStore(sql)` — a synchronous
  `PushSubscriptionStore` view of the same operations. The DO's
  Promise-style methods (`registerPushSubscription`,
  `unregisterPushSubscription`, `listPushSubscriptions`,
  `reapTerminalSubscriptions`) cache this on construction and
  call into it directly, avoiding an `Effect.runSync` per call.

Both surfaces share the SQL strings; there is exactly one place
in the codebase where the `push_subscriptions` table is touched
(`DurableObjectPushSubscriptionRepositoryLive.ts`).

## Consequences

**Easier**:

- "Where does push data go" is now a one-file answer.
- The alarm sweep, which already runs inside an Effect pipeline,
  picks up the port through the standard `Layer.mergeAll` in
  `QueueShop.layer()` and uses
  `PushSubscriptionRepository.reapByTicket(id)` for the
  application-layer reap hook.
- New push-side features (TTL expiry, multi-shop fan-out)
  attach to the port without touching QueueShop's SQL.
- The ADR-0074 anonymity contract has a clear enforcement
  surface — the port type signature carries only
  `(ticketId, endpoint, p256dh, auth)`; any future PII
  addition needs to mutate the public type.

**Harder**:

- The same set of operations is now visible in two shapes
  (Effect and sync). The sync surface is what the DO methods
  use; the Effect surface is the architectural port. The
  duplicate JSDoc tax is small and the adapter centralises the
  SQL anyway.

## Alternatives considered

- **Fold into `TicketRepository`.** Rejected because the
  aggregate boundary is different — subscriptions are bound to
  `(ticket_id, endpoint)` with their own lifecycle, and the
  ADR-0074 anonymity surface deserves its own type signature.
  Mixing them would invite future PII to ride in on the
  TicketRepository surface.
- **Keep raw `this.sql.exec` in QueueShop.** Rejected: the
  persistence-codec refactor (ADR-0019/0059 lint gate) already
  pinned that codec usage IS the discipline for `tickets` /
  `ticket_events`; carrying through to `push_subscriptions` is
  the obvious next move for consistency.
- **Pure Effect surface (no sync helper).** Rejected: the DO's
  Promise-style methods would each need an `Effect.runSync` with
  a freshly built Layer per call, adding ceremony with no
  semantic gain (the single-writer DO already serialises every
  call, so no concurrency benefit).

## References

- `packages/core/src/application/ports/PushSubscriptionRepository.ts`
- `apps/default/src/server/adapters/DurableObjectPushSubscriptionRepositoryLive.ts`
- ADR-0073 (Web Push channel) — the why
- ADR-0074 (push subscription anonymity) — the contract
- ADR-0020 (port tags) — the pattern
