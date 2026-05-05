# 0028. DurableObject SQL storage via drizzle-orm/durable-sqlite

- Status: accepted
- Date: 2026-05-05
- Deciders: Yasunobu
- Tags: durable-object, persistence, drizzle

## Context

ADR-0027 sketched a per-day DurableObject backed by KV-style storage
(`b:` / `c:` / `e:` / `s:` keys). Phase 0.6 needed first-class
indexes, transactional writes, and a query language richer than
`get` / `put` — the KV layout could not express the secondary
`bookings.code` index, the bitemporal event log, or the outbox
queue without manual encoding.

## Decision

Adopt `drizzle-orm/durable-sqlite` over `ctx.storage.sql`. Three
tables in the DO local SQLite mirror the same Drizzle schema D1
uses:

- `bookings` — read-side projection (snapshot per aggregate)
- `booking_events` — append-only truth log (bitemporal + versioned)
- `outbox` / `outbox_dead` — pending DO → D1 relay rows

Schema applied idempotently from the constructor under
`ctx.blockConcurrencyWhile`; `CREATE TABLE IF NOT EXISTS` makes
re-runs cheap.

## Consequences

- **Pros**: SQL + indexes + transactions + a typed query builder;
  the DO and D1 share Drizzle table definitions so a row exported
  from one side reloads on the other without translation. The
  bloom filter (Phase 0.5 KV-era pre-screen) became redundant
  (ADR-0033).
- **Cons**: The DO runtime ships its own SQLite build (no exotic
  extensions); the schema is applied at every cold start (cheap,
  ~6 idempotent `CREATE`s).

## Alternatives considered

- **Pure KV (status quo)**: forced manual indexes and prevented the
  bitemporal event log layout.
- **drizzle-kit migrations inside the DO**: produces a directory
  of `.sql` files plus a JSON journal that wrangler does not bundle
  by default; idempotent inline DDL keeps the schema co-located
  with the code that depends on it.

## References

- ADR-0027 (per-day DurableObject)
- ADR-0029 (EventSourcedRepository)
- `apps/default/src/server/durableObjects/schema.ts`
- `apps/default/src/server/adapters/DurableObjectEventSourcedRepositoryLive.ts`
