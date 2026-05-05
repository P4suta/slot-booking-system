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
| Customer can't cancel / reschedule | bloom filter + repository lookup | [Booking lookup fails](#booking-lookup-fails) |
| `availableSlots` returns empty | service catalog + `computeAvailableSlots` | [Empty availability](#empty-availability) |
| Stale `Held` bookings stuck | DO `alarm()` for hold expiry | [Holds not expiring](#holds-not-expiring) |
| Outbox not draining to D1 | DO `alarm()` outbox path | [Outbox stalled](#outbox-stalled) |
| PII not being purged | scheduled cron + `D1PiiPurger` | [PII purge stalled](#pii-purge-stalled) |
| GraphQL schema mismatch | Pothos build vs published artifact | [Schema drift](#schema-drift) |

---

## Architecture cheatsheet

```
GraphQL request                 ┌───────────────────┐
   │                            │ DaySchedule DO    │
   │  /graphql Mutation         │   - SQLite log    │
   ├───────────────────────────▶│   - Bloom index   │
   │                            │   - alarm() expiry│
   │                            │   - alarm() outbox│
   │                            └────────┬──────────┘
   │                                     │ outbox tick
   │                                     ▼
   │                            ┌───────────────────┐
   │  /graphql Query            │ D1 (Drizzle)      │
   └───────────────────────────▶│   bookings        │
                                │   booking_events  │
                                │   outbox          │
                                │   audit_log       │
                                └───────────────────┘
```

- **Writes**: GraphQL mutation → `env.DAY_SCHEDULE.idFromName(date)` →
  DO actor → use case (`HoldSlot` / `Confirm` / `Cancel` / `Reschedule`).
- **Reads (mutations' acks)**: DO returns `{ ok, result }` envelope.
- **Reads (availability)**: GraphQL query → D1 directly.
- **Outbox**: DO `alarm()` upserts read-model into D1.
- **PII purge**: cron `0 4 * * *` (daily 04:00 UTC) → `PurgeStalePii` →
  D1 `UPDATE bookings SET name_kana=NULL ...`.

---

## Booking write fails

**Symptoms**: GraphQL `holdSlot` returns 4xx or `error.code` of
`E_DOM_*`.

**Diagnosis**:
1. Confirm the request payload — `serviceId`, `providerId`,
   `resourceIds`, `slot.start`, `slot.end` must be the SAME values that
   came back from `availableSlots`. The DO trusts the capability.
2. If `error.code = E_VAL_PHONE_LAST4` etc. — the boundary parsing
   failed; the wire payload is malformed.
3. If `error.code = E_DOM_BOOKING_NOT_FOUND` on a confirm/cancel —
   the BookingCode + phoneLast4 pair didn't authenticate (see
   [Booking lookup fails](#booking-lookup-fails)).

**Diagnostics commands**:
```sh
# Tail logs for the deployment
wrangler tail
# Filter to mutations only
wrangler tail --format pretty | grep BookingHeld
```

**Resolution**:
- Validation errors are user-facing, not on-call concerns.
- Repeated `BookingNotFound` with valid-looking codes → see
  [Bloom index out of sync](#bloom-index-out-of-sync).

---

## Booking lookup fails

**Symptoms**: `confirmBooking` / `cancelBooking` return
`BookingNotFound` even though the customer claims a valid code.

**Diagnosis tree**:
1. Is the bloom filter saying it's there? Logs include
   `mayContain: true | false` once tracing is wired.
2. Does the DO have a row for the booking?
   ```sh
   # Inspect DO storage
   wrangler dev --inspect
   # then in the DevTools: open the DurableObjectState namespace
   ```
3. Did the booking expire (Held → Cancelled by alarm)?
4. Was the phone last-4 mistyped? PhoneMismatch and BookingNotFound
   are deliberately conflated at the API surface (anti-enumeration).

### Bloom index out of sync

If a booking exists in the DO/D1 but the bloom filter rejects:
- The DO's bloom is rebuilt at cold start from `loadAllBookings`.
  Bouncing the DO via `wrangler deploy` (or manual eviction) will
  trigger `ensureWarmed()` on the next request.

---

## Empty availability

**Symptoms**: `availableSlots(serviceId, date)` returns `[]` for a
business day that should have open slots.

**Likely causes (in order)**:
1. The service catalog (Phase 2) hasn't been seeded for that
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
- The DO's `alarm()` schedules itself only when there's something to
  do. If nothing was expiring at the last alarm tick, the next alarm
  isn't auto-rescheduled.
- This is a known gap (Phase 1 ships the alarm body; Phase 1.5 will
  schedule the next tick for `min(expiresAt) + 1m` after every fetch).

**Workaround until Phase 1.5**:
```sh
# Force an alarm via direct DO probe
wrangler tail --format pretty | grep "expireStaleHolds"
```

---

## Outbox stalled

**Symptoms**: D1 `bookings` table is missing rows that the DO has
already accepted.

**Diagnosis**:
- The DO's outbox runs inside `alarm()` after `expireStaleHolds`. If
  the alarm is silent, the outbox is silent too (same root cause as
  above).
- Check D1 row count vs DO storage count — divergence indicates an
  outbox lag, not data loss (the DO is the truth).

**Resolution**: Phase 1.5 wires the per-event push (currently we ship
the snapshot push, which is `at-least-once` idempotent).

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
   diagnosis path to this document. The runbook is a living document.
