# 0006. DO ↔ D1 sync: Outbox + at-least-once + idempotent application

- Status: accepted
- Date: 2026-05-05
- Deciders: Yasunobu
- Tags: infra, consistency

## Context

The Durable Object is the authority for the current day; D1 is the long-term store for history, statistics, and configuration. SYSTEM.md §3.8 calls for "rollback the whole thing on partial failure", but Cloudflare offers no distributed transaction across DO storage and D1. Pretending we have one would silently lose writes when D1 fails.

## Decision

Adopt the **transactional outbox** pattern. Inside one DO SQLite transaction, write both the domain change and a row to `pending_d1_writes`. A background loop (DO Alarm or queue) drains the outbox to D1.

- Outbox row schema: `{ id, kind, payload_json, created_at, attempt_count, last_error? }`.
- Each outbox `id` is a `BookingEventId` (TypeID `evnt_…`). D1 application is **idempotent by event id** — replaying a row is a no-op.
- The drain loop applies in `created_at` order per partition (per-day DO), uses an `INSERT … ON CONFLICT(id) DO NOTHING` upsert, and only deletes the outbox row after the D1 write returns success.
- On D1 failure: increment `attempt_count`, exponentially back off (alarm scheduling), surface alerts when `attempt_count >= N`.
- SYSTEM.md §3.8's "全体ロールバック" wording is downgraded to "DO transaction is the boundary; D1 catches up at-least-once with idempotent semantics".

## Consequences

- No write is ever silently lost — outbox is durable inside the DO until D1 acknowledges.
- D1 applies are eventually consistent; reads that need strict freshness must come from the DO. Read-only consumers of D1 (history, stats) tolerate a few seconds of lag.
- Idempotency is the load-bearing invariant. Every outbox handler must be tested for replay safety.

## Alternatives considered

- **Synchronous mirror inside the DO transaction**: relies on a network call holding the SQLite transaction open; the call cannot be undone if it fails after success at the wire.
- **D1 as primary, DO as cache**: D1 has no per-key locking, so concurrent confirms could double-book before any propagation.
- **No outbox, fire-and-forget**: a single failed D1 call drops the event. Unacceptable for an audit-bearing system.

## References

- SYSTEM.md §3.7, §3.8.
- Pat Helland, "Life beyond Distributed Transactions".
- Chris Richardson, "Microservices Patterns" (transactional outbox).
