# Runbook

Operational guide for production incidents and routine maintenance on
the deployed `slot-booking-system`. Iron principle 8 of SYSTEM.md
makes operability a first-class deliverable; this document is the
on-call companion.

> Code references throughout: branch `main`, repo
> `slot-booking-system`. The matching deployment lives in
> `bikeshop-booking` (separate repo) — its own `runbook.md` overrides
> any deployment-specific value.

## At a glance

| Concern | Where | Page in this doc |
|---|---|---|
| Booking won't accept hold | `DaySchedule` DO + `HoldSlot` use case | [Booking write fails](#booking-write-fails) |
| Customer can't cancel / reschedule | DO `bookings.code` UNIQUE-index lookup | [Booking lookup fails](#booking-lookup-fails) |
| `availableSlots` returns empty | service catalog + `computeAvailableSlots` | [Empty availability](#empty-availability) |
| Stale `Held` bookings stuck | DO `alarm()` for hold expiry | [Holds not expiring](#holds-not-expiring) |
| Outbox not draining to D1 | DO `alarm()` outbox path | [Outbox stalled](#outbox-stalled) |
| `outbox_dead` rows accumulating | retry budget exhausted | [Dead-letter accumulation](#dead-letter-accumulation) |
| PII not being purged | scheduled cron + `D1PiiPurger` | [PII purge stalled](#pii-purge-stalled) |
| GraphQL schema mismatch | Pothos build vs published artifact | [Schema drift](#schema-drift) |

---

## Architecture cheatsheet

```text
GraphQL request                 ┌──────────────────────┐
   │                            │ DaySchedule DO       │
   │  /graphql Mutation         │   (drizzle-orm /     │
   ├───────RPC method──────────▶│    durable-sqlite)   │
   │       (Either<E, R>)       │   - bookings         │
   │                            │   - booking_events   │
   │                            │   - outbox           │
   │                            │   - outbox_dead      │
   │                            │   - alarm() expiry   │
   │                            │   - alarm() outbox   │
   │                            └──────────┬───────────┘
   │                                       │ outbox tick
   │                                       ▼ (D1 batch)
   │                            ┌──────────────────────┐
   │  /graphql Query            │ D1 (Drizzle)         │
   └───────────────────────────▶│   bookings           │
                                │   booking_events     │
                                │   audit_log          │
                                └──────────────────────┘
```

- **Writes**: GraphQL mutation → `env.DAY_SCHEDULE.idFromName(date)`
  → `stub.holdSlot(input)` direct RPC method call (ADR-0030 /
  Phase 0.6) → use case (`HoldSlot` / `ConfirmBooking` /
  `CancelBooking` / `RescheduleBooking`). The RPC returns
  `Either<EncodedDomainError, EncodedResult>` so the discriminated
  union survives `structuredClone` across the actor boundary.
- **Reads (mutation acks)**: the resolver narrows the `Either`,
  returns the encoded success, and maps `Either.Left` to the typed
  GraphQL error union.
- **Reads (availability)**: GraphQL query → D1 directly via
  `D1WorldSnapshot` reader (Phase 0.9).
- **Outbox**: every `EventSourcedRepository.save()` enqueues one
  outbox row per event inside the same `ctx.storage.transactionSync`
  as the snapshot upsert and event-log append (ADR-0029 D3).
  `alarm()` drains rows whose `next_attempt_at <= now()` to D1
  with `ON CONFLICT DO NOTHING` on `booking_events.id` and
  `ON CONFLICT DO UPDATE` on `bookings.id` (at-least-once
  idempotent under alarm replay).
- **PII purge**: cron `0 4 * * *` (daily 04:00 UTC) →
  `PurgeStalePii` → D1 `UPDATE bookings SET name_kana=NULL,
  phone_last4=NULL, free_text=NULL ...` for terminal-state
  bookings older than the retention window.

---

## Booking write fails

**Symptoms**: GraphQL `holdSlot` returns a typed error with `code`
matching `E_DOM_*` / `E_VAL_*` / `E_INF_*`.

**Diagnosis**:

1. Confirm the request payload — `serviceId`, `providerId`,
   `resourceIds`, `slot.start`, `slot.end` must be the SAME values
   that came back from `availableSlots`. The DO trusts the slot
   capability.
2. If `error.code = E_VAL_PHONE_LAST4` etc. — boundary parsing
   failed; the wire payload is malformed.
3. If `error.code = E_DOM_BOOKING_NOT_FOUND` on a confirm/cancel —
   the BookingCode + phoneLast4 pair didn't authenticate (see
   [Booking lookup fails](#booking-lookup-fails)).
4. If `error.code = E_INF_CONCURRENCY` — the optimistic-concurrency
   check at the DO failed; a second writer slipped in. The actor
   model normally serialises writes per-instance, so a `Concurrency`
   error indicates either (a) a stale `expected` revision in the
   caller, or (b) a second worker reaching the DO with an older
   revision.

**Diagnostics commands**:

```sh
# Tail logs for the deployment
wrangler tail
# Filter to mutations only
wrangler tail --format pretty | grep BookingHeld
```

**Resolution**:

- Validation errors are user-facing, not on-call concerns.
- Concurrency errors should be retried client-side after re-reading
  the world snapshot.

---

## Booking lookup fails

**Symptoms**: `confirmBooking` / `cancelBooking` return
`BookingNotFound` even though the customer claims a valid code.

Phase 0.6 dropped the bloom-filter pre-screen (commit `5cd33a9`);
lookup is now a direct UNIQUE-index hit on `bookings.code` in the
DO's local SQLite, surfaced through the
`SecondaryIndexOps.findByKey` port.

**Diagnosis tree**:

1. Does the DO have a row for the booking?

   ```sh
   # Inspect DO storage
   wrangler dev --inspect
   # then in DevTools open the DurableObjectState namespace
   # and run: SELECT id, state FROM bookings WHERE code = '...'
   ```

2. Did the booking expire (Held → Cancelled by `alarm()`)?
3. Was the phone last-4 mistyped? `PhoneMismatch` and
   `BookingNotFound` are deliberately conflated at the API surface
   (anti-enumeration).

---

## Empty availability

**Symptoms**: `availableSlots(serviceId, date)` returns `[]` for a
business day that should have open slots.

**Likely causes (in order)**:

1. The service catalog (Phase 0.8) hasn't been seeded for that
   deployment.
2. `BusinessHours` for the requested weekday is empty / closed.
3. A `Closure` row covers the date.
4. Every Provider / Resource is disabled or absent on the date.
5. `slotGranularityMinutes` is 0 or negative (config error).

**Diagnostics**:

```sh
# Inspect D1 directly
wrangler d1 execute default-booking --command "SELECT count(*) FROM bookings WHERE substr(slot_start, 1, 10) = '2026-05-09'"
```

---

## Holds not expiring

**Symptoms**: bookings in `Held` state past `expiresAt` linger in the
DO storage.

**Diagnosis**:

The DO's `alarm()` reschedules itself at the end of every tick to
`min(earliest outbox next_attempt_at, earliest hold expiresAt,
now + 60s)`. If the alarm chain stops, no holds expire and no
outbox drain happens.

- Cold start without any writes leaves no alarm scheduled — the
  first write or RPC call after eviction will fire the alarm
  scheduler again.
- If `wrangler tail --format pretty | grep "expireStaleHolds"` is
  silent for a date that should have expired holds, force a probe
  by sending any RPC call to the DO (e.g. `describeBooking`).

---

## Outbox stalled

**Symptoms**: D1 `bookings` / `booking_events` are missing rows
that the DO has already accepted.

**Diagnosis**:

- The DO's outbox runs inside `alarm()` after `expireStaleHolds`.
  If the alarm chain is silent the outbox is silent too (same root
  cause as [Holds not expiring](#holds-not-expiring)).
- Check pending row count: `SELECT count(*), MIN(next_attempt_at)
  FROM outbox` inside the DO storage.
- Each row carries `attempts` and `last_error`. A row with
  `attempts >= 1` is on a backoff schedule (1s / 5s / 30s / 5min /
  30min). After 6 failed attempts it moves to `outbox_dead` (see
  [Dead-letter accumulation](#dead-letter-accumulation)).

**Resolution**:

- For lag without errors: trigger any DO RPC call to wake the
  alarm chain.
- For repeated failures: inspect `last_error` and address the
  D1-side cause (schema drift, transient unavailability, malformed
  payload).

---

## Dead-letter accumulation

**Symptoms**: rows accumulate in `outbox_dead` faster than they can
be inspected.

**Diagnosis**:

```sh
wrangler tail --format pretty | grep "outbox_dead"
```

Inspect rows: `SELECT id, type, last_error, died_at FROM
outbox_dead ORDER BY died_at DESC LIMIT 20`.

**Resolution**:

- Dead-letter rows are not auto-retried. After fixing the root
  cause, manually re-enqueue inside one `transactionSync`:
  `INSERT INTO outbox SELECT id, booking_id, seq, type, payload,
  snapshot, enqueued_at, enqueued_at, 0, NULL FROM outbox_dead
  WHERE ...` followed by `DELETE FROM outbox_dead WHERE ...`.
- Tracking: every dead-letter event should produce a follow-up
  ticket; the rate of dead-letters is a leading indicator of
  D1-side breakage.

---

## PII purge stalled

**Symptoms**: bookings with terminal state more than 2 years old
still carry `name_kana` / `phone_last4` / `free_text`.

**Diagnosis**:

1. Cron triggered? `wrangler tail --format pretty` filtered to
   `_tag: PiiPurged`.
2. Cron schedule correct? `wrangler.toml` `[triggers].crons` should
   contain `"0 4 * * *"`.
3. Time skew? D1 `datetime('now')` is UTC; the cutoff math runs in
   the Worker's `Date.now()` (also UTC).

**Manual run**:

```sh
# Trigger the scheduled handler from wrangler
wrangler dev --test-scheduled
# Then POST to the test endpoint
curl http://localhost:8787/__scheduled?cron=0+4+*+*+*
```

---

## Schema drift

**Symptoms**: Pothos GraphQL schema differs between deployments, or
introspection returns fields the resolvers don't implement.

**Diagnosis**:

- The schema is built at module load via `builder.toSchema()`. If a
  resolver file is missing from the side-effect imports in
  `apps/default/src/server/graphql/schema.ts`, its types disappear.
- Re-run `just typecheck` to catch missing resolver registrations.

---

## Routine maintenance

| Task | Cadence | Tooling |
|---|---|---|
| Drizzle migration apply | per release | `just migrate-local` (dev) / `wrangler d1 migrations apply DB --remote` (prod) |
| Mutation testing | quarterly | `just mutation` (workflow_dispatch) |
| Bench baseline check | per refactor | `just bench` |
| Type-coverage audit | per PR (CI) | `just type-coverage` (threshold 99.5 %) |
| ATTW package sanity | pre-publish | `just attw` |

---

## On-call escalation

1. Look up the incident in this runbook.
2. Check `wrangler tail` for `_tag` of relevant errors.
3. If the issue isn't here, file an incident note and append the
   diagnosis path to this document. The runbook is a living
   document.
