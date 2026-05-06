# Operator runbook

How to investigate the operationally interesting failure modes the
system exposes. The scope is **local development**; production
deployment + on-call concerns are out of scope (see ADR-0036's
deferred items).

## Layered observability

Every request runs through these layers; the operator's first move
is to find the correlated trace id and follow it across them.

| Layer                | Sink                                          | Find by                                  |
| -------------------- | --------------------------------------------- | ---------------------------------------- |
| GraphQL resolver     | `BookingError` payload (response.errors[*])   | `code` + `tag` from the response         |
| Effect runtime       | `WorkersLoggerLive` → `console.{info,warn,error}` JSON | `traceId` (FiberRef-decorated) |
| DO local SQL         | `bookings` / `booking_events` / `outbox`      | `bookingId` / `seq`                       |
| D1 mirror            | same shape, plus `audit_log`                  | `bookingId` / `traceId`                  |

## Common incidents

### `holdSlot` returns `InvalidSlotToken` for every request

**Symptom**: every customer request fails the slot-token verify.

**Likely cause**: `SLOT_HMAC_SECRET` rotated without invalidating
in-flight `availableSlots` results in the client's session storage,
or the Worker / SvelteKit deployments are reading different secrets.

**Diagnose**:

1. Log the secret hash on the server (`crypto.subtle.digest`'s SHA-256)
   and compare to the value the SvelteKit deployment thinks it has.
2. Confirm `wrangler.toml` `[vars] SLOT_HMAC_SECRET` matches both
   sides for `wrangler dev --local`.

**Fix**: align secrets; restart the Worker; ask users to
re-search slots.

### Outbox drainage stalls

**Symptom**: D1 `booking_events` lags DO state by minutes (tail
via `wrangler d1 execute DB --command 'SELECT MAX(recorded_at) FROM
booking_events'`).

**Likely cause**: alarm is firing but D1 batch insert fails (size
limit, schema drift, etc.). The retry budget is six attempts with
exponential backoff (1s / 5s / 30s / 5m / 30m); after that the row
moves to `outbox_dead`.

**Diagnose**:

1. Inspect `outbox.attempts` / `outbox.last_error` for unfinished
   rows: `SELECT id, attempts, last_error FROM outbox ORDER BY
   next_attempt_at`.
2. Check `outbox_dead` for any rows past the retry budget.
3. Pull the matching trace id from `audit_log` — every outbox
   write carries one.

**Fix**:

1. Resolve the underlying error (D1 schema change, capacity).
2. Re-enqueue from `outbox_dead`:
   `INSERT INTO outbox (...) SELECT ... FROM outbox_dead WHERE id IN (...)`.
3. Trigger an immediate alarm: `wrangler do execute DAY_SCHEDULE
   --id <date> --method alarm` (or wait the next 60 s tick).

### Hold expiry not firing

**Symptom**: `Held` bookings stay past their `expires_at` instead
of moving to `Cancelled`.

**Likely cause**: alarm scheduling tries to pick the minimum of
(earliest hold expiry, earliest outbox retry, +60 s); a bug in the
`reduce` could elide the expiry. Check the alarm-set telemetry log
line.

**Diagnose**:

1. Log the next-alarm-at value on every alarm tick.
2. Manually invoke `alarm()` via `wrangler do execute`.

**Fix**: usually a code issue in `DaySchedule.alarm()` —
fall through to the test suite (`packages/core/test/property/`)
to reproduce.

### PII purge job over-aggressive

**Symptom**: bookings older than 2y appear with `name_kana = NULL`
and the audit row says they were purged a day later than expected.

**Likely cause**: `Duration` cutoff matches calendar boundaries in
UTC; deployments in late-evening Asia/Tokyo can see a 1-day off
boundary.

**Diagnose**: inspect the cron config (`wrangler.toml` `[triggers]`)
and the `D1PiiPurgerLive` cutoff arithmetic.

**Fix**: adjust the cron or the cutoff Duration; PII columns are
restorable from the audit log row's `bookingId` only if the
operator persists a separate backup (none in the local-dev scope).

## Tracing a single request end-to-end

1. Pull the response `traceId` (decorated by `WorkersLoggerLive`).
2. Filter Workers Logs by that id: `wrangler tail | grep <traceId>`.
3. Pivot to D1: `SELECT * FROM audit_log WHERE trace_id = '<traceId>'`.
4. Inspect the DO's outbox: `wrangler do execute DAY_SCHEDULE --id
   <date> --method <inspect>` (the inspect surface lands with the
   future Miniflare integration suite).

## Where to look for what

| Question                                    | Where                                                    |
| ------------------------------------------- | -------------------------------------------------------- |
| Why was a transition refused?               | GraphQL `BookingError.tag`; full error chain in Workers Logs |
| What state is a booking in right now?       | DO local SQL `bookings.state`                            |
| Did this event reach D1?                    | D1 `booking_events.id` (idempotent; same id = same event)|
| Did the outbox fail to drain?               | DO local SQL `outbox.attempts` / `outbox_dead`            |
| Did the audit row land?                     | D1 `audit_log` filtered by `traceId` / `bookingId`        |
| What capability authorised a staff action?  | `audit_log.actor` + the resolver-level header capture   |
