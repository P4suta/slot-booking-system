# 0027. Per-day DurableObject + outbox-to-D1 — write-side architecture

- Status: superseded by [ADR-0053](./0053-single-writer-do.md) — the per-day DO partition is replaced by the single-writer QueueShop; the outbox + alarm patterns survive but the actor lifetime + partition key changed.
- Superseded-By: ADR-0053
- Date: 2026-05-05
- Deciders: Yasunobu
- Tags: durable-object, persistence, concurrency

## Context

ADR-0005 chose a Durable Object as the authoritative store for in-flight
holds, and ADR-0006 sketched a DO ↔ D1 outbox sync. Phase 1 needs to
turn that sketch into running code: pick a granularity for the DO,
decide what state lives where, and define the outbox cadence.

## Decision

### Granularity — one DO per `(deployment, date)`

The DO id is derived from the booking's `date` (`env.DAY_SCHEDULE.idFromName(date)`).
Properties:

- All writes for one day land on the same actor → no two `HoldSlot`
  calls for the same day can interleave at the application layer
  (this is the architectural invariant SYSTEM principle 4 names).
- Cross-day independence: different days route to different actors,
  so a heavy day for one date doesn't bottleneck the others.
- Eviction is per-day: an idle date's DO can be reaped without
  affecting in-progress days.

### State layout inside the DO

| Key | Value | Role |
|---|---|---|
| `b:<bookingId>` | encoded `Booking` | read-side projection (snapshot) |
| `c:<bookingCode>` | `bookingId` | reverse index for self-service lookup |
| `e:<bookingId>:<seq>` | encoded `BookingEvent` | append-only event log (truth) |
| `s:<bookingId>` | `seq` integer | per-aggregate monotonic counter |

Both the snapshot and the event log live in the DO; D1 is the
long-retention mirror, populated via the outbox on each `alarm()`
tick.

### Per-fetch flow

```text
DurableObject.fetch(req)
  ensureWarmed()                        // load bookings → bloom index
  parse request body via Schema.Union
  build per-request Layer
    BookingRepository ← DurableObjectStorage
    EventStore        ← DurableObjectStorage
    BookingCodeIndex  ← Bloom filter (in-process)
    Clock             ← SystemClockLive
    IdGenerator       ← UlidIdGeneratorLive
    Logger            ← SilentLoggerLive (Phase 1.x → WorkersLogger)
  Effect.runPromise(useCase.pipe(Effect.provide(layer)))
  serialise as { ok, result | error } JSON
```

### Alarm flow

```text
DurableObject.alarm()
  ensureWarmed()
  expireStaleHolds()    // load all bookings, Cancel each Held past expiry
  drainOutboxToD1()     // upsert every booking into D1 via D1BookingRepository
```

`alarm()` runs both passes in sequence so a single wake-up covers
both maintenance tasks. The outbox is **at-least-once idempotent**:
re-applying the same snapshot via `BookingRepository.upsert` is a
no-op on D1 (`ON CONFLICT DO UPDATE` with the same values).

### What the DO does NOT do

- Service catalog, business hours, closures, providers, resources →
  D1 (Phase 2 schema). The DO doesn't replicate them.
- Long-retention audit logs → D1.
- PII purging → daily cron in the parent Worker (`scheduled` handler),
  not the DO. DO storage stays slim.

## Consequences

- **Pros**: per-day actor model gives a clean concurrency story
  without explicit locks. Each DO carries ≤ ~50 bookings (small-shop
  scale per SYSTEM); the entire state fits in memory and the bloom
  filter fits in microseconds.
- **Cons**: cross-day operations (e.g. "list all bookings this week")
  cannot be served from a single DO — they go to D1. Acceptable
  because reads dominate the read-only D1 path.

## Alternatives considered

- **One DO per booking**: too many actors for a small shop, hold
  expiry would need a separate scheduler.
- **One DO for the whole deployment**: serialises every day's writes
  through one actor → throughput collapses on busy days.
- **No DO, only D1 with row-level locking**: D1 lacks
  `SELECT … FOR UPDATE`, so we'd need a manual `version` column +
  retry on conflict. The DO actor model removes that complexity.

## References

- ADR-0005 (HOLD store DO only).
- ADR-0006 (DO/D1 outbox sync).
- ADR-0008 (apps vs core layout).
- ADR-0020 (port Tags), ADR-0024 draft (Event Sourcing CQRS).
- `apps/default/src/server/durableObjects/DaySchedule.ts`,
  `apps/default/src/server/adapters/D1BookingRepositoryLive.ts`.
