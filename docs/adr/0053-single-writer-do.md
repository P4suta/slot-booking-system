# ADR-0053: Single-writer QueueShop Durable Object

- Status: Accepted
- Date: 2026-05-08
- Supersedes: ADR-0027 (DaySchedule per-day DO)

## Decision

One `QueueShop` Durable Object instance per deployment, keyed by
`env.QUEUE_SHOP.idFromName("shop")`. The actor model serialises every
write through a single isolate, so the FIFO queue is consistent
without code-level locks.

CRDT machinery is **explicitly rejected**: there is no second writer
to merge against. A multi-shop future is a permanent non-goal (the
SYSTEM-level Iron Principles confine each deployment to one shop;
multi-tenant is "a different project").

DO migration v2 in `wrangler.toml`:

```toml
[[migrations]]
tag = "v2"
new_sqlite_classes = ["QueueShop"]
deleted_classes = ["DaySchedule"]
```

The DO holds three local-SQLite tables: `tickets` (snapshot
projection), `ticket_events` (append-only log), `outbox` (relay
queue drained into D1 by the `alarm()` tick).

## Consequences

- `dispatch(action: QueueAction): Promise<QueueResult>` is the
  single entry point; the worker resolves the stub once per request
  via `idFromName("shop")`.
- The `alarm()` tick fires the no-show TTL sweep
  (`Called → NoShow` for `called_at < now - NO_SHOW_TIMEOUT_SECONDS`,
  default 300). The same alarm drains the outbox.
- The DurableObject sanitiser (`effectRpc/transport.ts`, ADR-0044)
  is preserved verbatim: every cross-isolate hop runs through it.
