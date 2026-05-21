# Glossary

Industry-agnostic vocabulary used throughout `packages/core`. Every
term here is **business-domain neutral** — there are no cars, haircuts,
patients, or pets in this list. Deployments translate these terms into
local UI copy without touching code.

## Core entities

- **Ticket** — an aggregate representing one customer's place in the
  queue. Carries `id`, monotonic `seq`, `state` (Waiting / Called /
  Overdue / Served / NoShow / Cancelled — ADR-0071 removed `Serving`,
  ADR-0072 introduced `Overdue`), the anonymous `CustomerHandle`, and
  an optional free-text note.
- **TicketEvent** — an immutable record of a state transition on a
  Ticket (Issued / Called / MovedToOverdue / Nudged / AppointmentLapsed
  / Served / NoShowed / Cancelled / Recalled / Reordered / CheckedIn
  / Rescheduled). The append-only log in `ticket_events` is the
  canonical source of truth; the `tickets` row is a read-side
  projection materialized view (ADR-0059).
- **QueueShop** — the Cloudflare DurableObject that hosts the queue.
  One actor per shop (`idFromName("shop")` for the demo deployment),
  serialising every state transition through `dispatch`. Holds the
  local SQLite with `ticket_events`, `aggregate_snapshots`, `tickets`,
  and `outbox`.
- **AggregateSnapshot** — full Ticket payload captured every K events
  (`SNAPSHOT_INTERVAL = 200`) so `load(id)` hydrates from a snapshot
  baseline plus the trailing event delta instead of replaying the
  whole history.
- **AuditLog** — staff-action trail mirrored to D1 by the alarm relay.
  Longer retention than `ticket_events`; contains no customer PII.

## Customer identity

- **AnonymousHandle** — the `(nameKana, phoneLast4)` pair that
  identifies a customer for self-service mutations without an account
  (ADR-0054). The frontend keeps the handle in a URL fragment so it
  never reaches the worker logs; the worker accepts it on every
  mutation and verifies against the stored fields.
- **NameKana** — full-width katakana of the customer's name (used by
  staff to call the next ticket aloud).
- **PhoneLast4** — the last four digits of the customer's phone; a
  weak factor that stops `TicketId` enumeration from mutating someone
  else's waiting position.

## Queue lifecycle vocabulary

- **Waiting** — issued, not yet called.
- **Called** — staff invoked `CallNext`; the customer is being served
  or about to be. Invariant: at most one Ticket is `Called` at a time.
- **Recalled** — staff reversed an accidental `CallNext`; the Ticket
  returns to `Waiting` with the original `seq` preserved. The audit
  log retains both the `Called` and the `Recalled` event.
- **Served** — work completed, terminal state.
- **Overdue** — the at-counter timeout window between `Called` and
  `NoShow` (ADR-0072). Reached automatically by the DO alarm sweep
  once `now - calledAt > OVERDUE_AFTER_CALLED_SECONDS`. While in
  `Overdue` the customer notification re-fires every
  `NUDGE_INTERVAL_SECONDS` up to `MAX_NUDGES` times.
- **NoShow** — `Overdue` ran out the nudge budget (`nudge_count >=
  MAX_NUDGES` and one more interval has elapsed) or staff manually
  marked the Ticket absent. Terminal.
- **Cancelled** — voluntarily ended by the customer (with handle
  authentication) or by staff. Terminal.

## Capability / authorisation vocabulary

- **StaffCapability** — the single `operate_queue` scope the staff
  token grants (ADR-0055). `POST /api/v1/staff/login` exchanges the
  deployment's `STAFF_SESSION_SECRET` for an HS256 JWT plus an
  HMAC-signed cookie; the secret-comparison path uses the
  constant-time comparator from ADR-0058.
- **CustomerHandle** — see *AnonymousHandle*.

## Identifier vocabulary

- **TypeID** — internal id of the form `<prefix>_<ULID>`. Prefixes:
  `tkt` (TicketId), `tev` (TicketEventId), `staf` (StaffId), `audt`
  (AuditLogId), `idem` (IdempotencyKeyId). See ADR-0003.
- **Seq** — monotonic per-shop integer assigned at issue time. Drives
  the `head` projection (`min seq` of all `Waiting` tickets) and the
  display number the customer sees on their slip.
- **TraceId** — request-scoped correlation id surfaced in logs and
  HTTP response headers (ADR-0026).

## Time-axis vocabulary (post-pivot, ADR-0066 onwards)

- **Lane** — discriminant on every Ticket (ADR-0062). One of
  `walk-in | reservation | priority`. Drives the per-lane FIFO
  chain CallNext walks.
- **Slot** — a value object pinning a (date, bucket, granularity,
  capacity) tuple in the business time zone (ADR-0066). Reservation
  tickets carry a `Slot`-derived `appointmentAt` instant.
- **Bucket** — integer index within a day under a `Granularity`
  (15 / 30 / 60 minutes). Bucket 0 starts at 00:00 in the business
  time zone.
- **Granularity** — bucket length in minutes (15 / 30 / 60). Picked
  per deployment.
- **AppointmentAt** — the `Instant` encoded on a reservation Ticket
  (ADR-0066). `null` for walk-in.
- **EDF** — earliest-deadline-first promotion: the reservation head
  jumps past the static `priority > walk-in > reservation` chain
  when its `appointmentAt - now ≤ grace` (ADR-0067).
- **CheckIn** — customer-arrival audit event recorded before
  `Called` (ADR-0068). Marks a reservation as physically present
  so the EDF chain may promote it.
- **Nudged** — one fire of the Overdue → customer notification loop
  (ADR-0072). Increments `nudgeCount`, stamps `lastNudgedAt`.
- **NudgeCount** — running count of `Nudged` events fired against
  the current `Called → Overdue` window. Capped at `MAX_NUDGES`.
- **LastNudgedAt** — most recent `Nudged` event's `occurredAt`.
  Used as the cadence-guard reference by the alarm sweep.

## Notification vocabulary (ADR-0073 / ADR-0074)

- **PushSubscription** — a `(ticketId, endpoint, p256dh, auth)`
  row in the DO's `push_subscriptions` table. Ticket-scoped,
  reaped on terminal transition and on the push service's
  404 / 410.
- **VAPID** — Voluntary Application Server Identification (RFC
  8292). The deployment carries a P-256 key pair; the public key
  is embedded in the web bundle, the private key signs ES256 JWTs
  the push service consumes per delivery.

## Bookkeeping

The vocabulary is owned by the core. Adding a term requires updating
this file. Industry-specific vertical terms (treatment / examination
/ repair / haircut) must not enter the core lexicon — those belong
to a deployment's UI copy only. Time-axis structural terms
(`appointmentAt`, `Slot`, `Bucket`, `Granularity`) are core under
ADR-0066.
