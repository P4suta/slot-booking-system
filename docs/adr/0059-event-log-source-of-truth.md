# ADR-0059: Event log is the source of truth + aggregate snapshots

- Status: Accepted
- Date: 2026-05-09
- Refines: ADR-0051 (event-sourced queue), ADR-0027 (DO outbox relay)

## Decision

The QueueShop DurableObject's local SQLite holds three storage
roles, with sharply separated semantics:

1. `ticket_events` — append-only event log; **canonical truth**.
   Every ticket lifecycle transition is written here exactly once
   inside the `save(id, expected, events, next)` synchronous batch.
2. `aggregate_snapshots` — full Ticket payload captured every K
   events (`SNAPSHOT_INTERVAL = 200`). The row is **upserted** keyed
   on `ticket_id`, so the table never outgrows the live ticket
   cardinality. Pure load accelerator: discarding it loses no
   information, only the read-side replay shortcut.
3. `tickets` — column-projected **read-side projection materialized
   view**. Rebuilt by `applyEvent`-folding each emitted event during
   `save`; serves the operator dashboard's `listAll`, the customer
   `myTicket` lookup, and the D1 mirror.

Load reads from `aggregate_snapshots` first; falls back to
event-log replay from `seq = 0`; falls back to the projection table
during the migration window. The projection table is kept on the
write path (atomic snapshot + projection write costs nothing the DO
isn't already paying) but is no longer consulted as the canonical
state on the read path once the migration window closes.

## Context

The pre-snapshot setup persisted both the event log AND a fully
projected `tickets` row on every `save`, treating the row as both
write-side aggregate state and read-side query target. The
ambiguity made it unclear which was canonical (could the projection
drift? would a reset reach the event log?), and the load path read
the projection — meaning the event log was effectively a write-only
audit trail rather than a true source of truth.

K=200 is the AWS Aurora-recommended snapshot cadence (≈ 1 day at
target production volume). Three is the AWS-recommended growth
factor for the recurrence — independent decision, see ADR-0015 for
the backoff side.

## Consequences

- The event log can be replayed end-to-end (e.g. for a backup
  restore or a projection-format migration) and produce the same
  state. The projection becomes regenerable rather than primary.
- Snapshot writes amortise: 1 snapshot every 200 ticket transitions
  costs negligibly compared to the 200 event inserts that produced
  it. Worst-case load replay is bounded by 199 events.
- Adding a new query shape (e.g. "tickets by served-at hour") no
  longer requires a write-path migration; it can be derived from
  the event log into a new projection table without any
  invariant-shifting on the canonical store.
- The `save(id, expected, events, next)` signature still carries
  `next` because the DO computes the projection alongside the
  events and atomic write is the cheapest invariant; the
  `next` argument may be dropped if a future event-handler
  subscription pattern materialises the projection out of band.
- Rolling back to the pre-snapshot setup is a delete on the
  `aggregate_snapshots` table; no data loss possible.
