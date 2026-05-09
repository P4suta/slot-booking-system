# Operator runbook

How to investigate the operationally interesting failure modes the
queue exposes. The scope is **local development**; production
deployment + on-call concerns are out of scope (see ADR-0036's
deferred items).

## Layered observability

Every request runs through these layers; the operator's first move
is to find the correlated trace id and follow it across them.

| Layer                | Sink                                             | Find by                                  |
| -------------------- | ------------------------------------------------ | ---------------------------------------- |
| Hono router          | JSON envelope (`{ok:false, error:{...}}`)         | `code` + `_tag` from the response body   |
| Effect runtime       | `WorkersLoggerLive` → `console.{info,warn,error}` JSON | `traceId` (FiberRef-decorated) |
| QueueShop DO storage | `ticket_events` / `aggregate_snapshots` / `tickets` / `outbox` | `ticketId` / `seq`             |
| D1 mirror            | same shape (read-side), plus `audit_log`         | `ticketId` / `traceId`                   |

## Common incidents

### `IssueTicket` returns `InvalidNameKana` / `InvalidPhoneLast4`

**Symptom**: every customer request fails the boundary parse.

**Likely cause**: the frontend is normalising the input differently
from the core (full-width vs half-width katakana, wrong digit
count). The accumulating `parseCustomerHandle` returns every field
error; the strict `parseCustomerHandleStrict` returns the first.

**Diagnose**:

1. Inspect the failing API request body with the staff dashboard's
   network tab.
2. Re-run the parser locally: `parseCustomerHandle("ヤマダ", "1234")`
   in `pnpm -F @booking/core repl`.
3. Confirm the frontend's normalisation (`apps/web/src/lib/handle.ts`)
   matches the core's `normalizeNameKana`.

**Fix**: align normalisation; ship the frontend fix; users with
in-flight tickets are unaffected since the parser only gates writes.

### Outbox drainage stalls

**Symptom**: D1 `ticket_events` lags QueueShop DO state by minutes
(tail via `wrangler d1 execute DB --command 'SELECT MAX(recorded_at)
FROM ticket_events'`).

**Likely cause**: alarm is firing but D1 batch insert fails (size
limit, schema drift, etc.). The retry budget is six attempts with
backoff (decorrelated jitter, base 1 s, cap 30 m); after that the row
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
3. Trigger an immediate alarm: `wrangler do execute QUEUE_SHOP --id
   shop --method alarm` (or wait the next tick).

### NoShow auto-mark not firing

**Symptom**: tickets stay in `Called` past `NO_SHOW_TIMEOUT_SECONDS`
instead of advancing to `NoShow`.

**Likely cause**: alarm scheduling tries to pick the minimum of
(earliest no-show timeout, earliest outbox retry, +60 s); a bug in
the `reduce` could elide the timeout. Check the alarm-set telemetry
log line.

**Diagnose**:

1. Log the next-alarm-at value on every alarm tick.
2. Manually invoke `alarm()` via
   `wrangler do execute QUEUE_SHOP --id shop --method alarm`.

**Fix**: usually a code issue in `QueueShop.alarm()` — fall through
to the test suite (`packages/core/test/property/`) to reproduce.

### PII purge job over-aggressive

**Symptom**: tickets older than 2y appear with `name_kana = NULL`
and the audit row says they were purged a day later than expected.

**Likely cause**: `Duration` cutoff matches calendar boundaries in
UTC; deployments in late-evening Asia/Tokyo can see a 1-day off
boundary.

**Diagnose**: inspect the cron config (`wrangler.toml` `[triggers]`)
and the `D1PiiPurgerLive` cutoff arithmetic.

**Fix**: adjust the cron or the cutoff Duration; PII columns are
restorable from the audit log row's `ticketId` only if the
operator persists a separate backup (none in the local-dev scope).

### Customer handle mismatch on cancel

**Symptom**: a customer reports `PhoneMismatch` when cancelling
their own ticket.

**Likely cause**: the `(nameKana, phoneLast4)` pair on the cancel
request does not match the values stored at issue. Either the
customer typed differently the second time, or the URL fragment
holding the handle was clobbered by a redirect.

**Diagnose**: compare the request body to
`SELECT name_kana, phone_last4 FROM tickets WHERE id = ?` (the
projection mirrors what `authenticateCustomer` checks against).

**Fix**: the customer re-enters the original values; staff-side
cancel is the override path (no handle, capability already verified).

### Stale snapshot after a load

**Symptom**: `load(id)` returns a state that disagrees with the
operator dashboard's `listAll`.

**Likely cause**: `aggregate_snapshots` row drifted from the event
log — should not happen in normal operation since both are written
inside the same `save` batch, but a partial write from an aborted
transaction could leave the snapshot ahead of the events.

**Diagnose**:

1. Compare `aggregate_snapshots.revision` against the count of
   `ticket_events WHERE ticket_id = ?`.
2. If they disagree, the load path replays from snapshot.revision +
   delta — verify the delta matches by walking the event log.

**Fix**: drop the stale snapshot row (`DELETE FROM
aggregate_snapshots WHERE ticket_id = ?`); the next save will
re-emit it at the next K-event boundary. The event log is canonical.

## Tracing a single request end-to-end

1. Pull the response `traceId` (decorated by `WorkersLoggerLive`).
2. Filter Workers Logs by that id: `wrangler tail | grep <traceId>`.
3. Pivot to D1: `SELECT * FROM audit_log WHERE trace_id = '<traceId>'`.
4. Inspect the DO's storage:
   `wrangler do execute QUEUE_SHOP --id shop --method <inspect>`
   (the inspect surface lands with the future Miniflare integration
   suite).

## Where to look for what

| Question                                    | Where                                                     |
| ------------------------------------------- | --------------------------------------------------------- |
| Why was a transition refused?               | API envelope `error._tag`; full error chain in Workers Logs |
| What state is a ticket in right now?        | DO `tickets.state` (read-side projection)                  |
| What is the canonical history of a ticket?  | DO `ticket_events WHERE ticket_id = ? ORDER BY seq`        |
| Did this event reach D1?                    | D1 `ticket_events.id` (idempotent; same id = same event)   |
| Did the outbox fail to drain?               | DO `outbox.attempts` / `outbox_dead`                       |
| Did the audit row land?                     | D1 `audit_log` filtered by `traceId` / `ticketId`          |
| What capability authorised a staff action?  | `audit_log.actor` + the router-level header capture      |
