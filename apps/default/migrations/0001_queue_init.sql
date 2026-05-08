-- Initial D1 schema for the queue domain.
-- Tables:
--   - tickets:        read-mirror of the QueueShop DO's projection.
--   - ticket_events:  append-only event log (5y retention per ADR-0009).
--   - audit_log:      staff/customer command audit trail.
-- The DO's local SQLite owns the canonical write side; outbox rows
-- in the DO drain into the D1 mirrors above on each alarm tick.

CREATE TABLE IF NOT EXISTS tickets (
  id text NOT NULL PRIMARY KEY,
  seq integer NOT NULL,
  state text NOT NULL,
  name_kana text,
  phone_last4 text,
  free_text text,
  issued_at text NOT NULL,
  called_at text,
  served_at text,
  cancelled_at text,
  marked_at text,
  reason text,
  cancelled_by text,
  called_by text,
  served_by text,
  marked_by text,
  payload text NOT NULL,
  revision integer NOT NULL DEFAULT 0,
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS ticket_events (
  id text NOT NULL PRIMARY KEY,
  ticket_id text NOT NULL,
  seq integer NOT NULL,
  type text NOT NULL,
  occurred_at text NOT NULL,
  recorded_at text NOT NULL,
  payload text NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_ticket_events_ticket_seq ON ticket_events (ticket_id, seq);

CREATE TABLE IF NOT EXISTS audit_log (
  id text NOT NULL PRIMARY KEY,
  actor text NOT NULL,
  action text NOT NULL,
  trace_id text,
  data text NOT NULL,
  recorded_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
