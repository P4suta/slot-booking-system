# Glossary

Industry-agnostic vocabulary used throughout `packages/core`. Every
term here is **business-domain neutral** — there are no cars, haircuts,
patients, or pets in this list. Deployments translate these terms into
local UI copy without touching code.

## Core entities

- **Ticket** — an aggregate representing one customer's place in the
  queue. Carries `id`, monotonic `seq`, `state` (Waiting / Called /
  Served / NoShow / Cancelled), the anonymous `CustomerHandle`, and an
  optional free-text note.
- **TicketEvent** — an immutable record of a state transition on a
  Ticket (Issued / Called / Recalled / Served / NoShowed / Cancelled).
  The append-only log in `ticket_events` is the canonical source of
  truth; the `tickets` row is a read-side projection materialized view
  (ADR-0059).
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
- **NoShow** — `NO_SHOW_TIMEOUT_SECONDS` elapsed without arrival, or
  staff manually marked the Ticket absent. Terminal.
- **Cancelled** — voluntarily ended by the customer (with handle
  authentication) or by staff. Terminal.

## Capability / authorisation vocabulary

- **StaffCapability** — capability set the staff token grants
  (`operate-queue`, `view-pii`, …). The Hono router checks the
  presented token against `STAFF_SESSION_SECRET` for now; the
  capability granularity expands when JWT-based auth lands.
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

## Bookkeeping

The vocabulary is owned by the core. Adding a term requires updating
this file. Any term that hints at a specific industry (e.g.
"appointment", "treatment", "examination", "repair", "haircut") must
not enter the core lexicon — those belong to a deployment's UI copy
only.
