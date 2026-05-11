# ADR-0082: Versioned migration ledger for QueueShop DO

- Status: Accepted (Backfilled 2026-05-12)
- Date: 2026-05-10 (originally landed in commit `612bc7a`)
- Stage: E / S10
- Refines: ADR-0061 (DO hibernating WebSocket projection feed)

## Decision

Replace the prior "PRAGMA-poll-on-every-boot" schema
bootstrap inside `QueueShop`'s SQLite storage with an
append-only ordered ledger of `Migration` records, recorded
under a private `_migrations(id, name, applied_at)` table. On
every cold boot the DO compares the ledger against the
`MIGRATIONS` source list and replays only the pending tail.

```ts
type Migration = {
  readonly id: number
  readonly name: string
  readonly up: (sql: SqlStorage) => void
}

const MIGRATIONS: readonly Migration[] = [
  { id: 1, name: "initial-schema",   up: …seed tickets/events/outbox… },
  { id: 2, name: "appointment-at",   up: addColumnIfMissing("tickets", …) },
  { id: 3, name: "checked-in-at",    up: addColumnIfMissing("tickets", …) },
]
```

### Legacy seeding

DOs that were created before this ledger landed already have
the v1 tables + v2/v3 columns. The first boot under the new
code path inspects the live schema via `PRAGMA table_info(...)`
and pre-marks every migration whose target shape is already
satisfied. Subsequent boots skip the seed path entirely.

### Why a ledger, not idempotent migrations alone

The pre-S10 approach ran a `tablesToDDL(...)` flush + every
ALTER TABLE inside `IF NOT EXISTS` / column-existence guards
on every boot. Each guard pays a `PRAGMA table_info` cost
even when the schema is in steady state, and adding a new
migration meant editing the run-on-every-boot function in
two places (the SQL itself + the guard for the next boot
after deploy). The ledger collapses both: the migration list
is a single append, and the runtime cost is O(1) after the
first boot once the row is in `_migrations`.

## Consequences

- Schema evolution is now one append to `MIGRATIONS`. Each
  entry's `up` stays idempotent (the project leans on
  `IF NOT EXISTS` / `addColumnIfMissing`) so a re-run on a
  partially-applied schema cannot corrupt state.
- `ensureDurableObjectSchema(sql)` is the single boot entry
  for the DO; nothing else in the codebase issues DDL
  against the DO's local SQLite.
- Legacy DOs migrate transparently on first boot under the
  new code (the seed path pre-fills the ledger from the live
  schema). No manual deploy step required.

## Status

- 2026-05-10 — Migration ledger lands in commit `612bc7a`,
  ADR docstring referenced inline in the commit message.
- 2026-05-12 — ADR file backfilled in the obs sprint
  cleanup (the commit's ADR-0082 citation was a dangling
  reference until now).
