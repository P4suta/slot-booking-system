# ADR-0074: Push subscription anonymity contract

- Status: Accepted
- Date: 2026-05-21
- Refines: ADR-0054 (customer anonymous handle), ADR-0009 (logging PII discipline)
- Companion: [ADR-0072](./0072-overdue-state-and-nudge-loop.md), [ADR-0073](./0073-web-push-channel.md)

## Decision

The Web Push channel introduced in ADR-0073 conforms to ADR-0054
anonymity on two distinct axes, each enforced by code and by review:

1. **Subscription identifier (the row in `push_subscriptions`)**:
   - Scoped to `(ticket_id, endpoint)` — never to a customer handle,
     a session id, or a user account.
   - Carries the opaque `endpoint` URL + the opaque `p256dh` /
     `auth` ECDH material, plus `created_at`.
   - **Carries no `nameKana`, no `phoneLast4`, no `appointmentAt`,
     no IP, no User-Agent.**
   - Deleted on the ticket's terminal transition (`Served | NoShow |
     Cancelled`) so the subscription has the same retention window
     as the ticket aggregate (ADR-0009 PII TTL).
   - A subscription row is **also** deleted when the push service
     responds `404` or `410` (subscription invalidated by the
     browser).

2. **Push payload body (the bytes delivered to the device)**:
   - Limited to:
     - `displaySeq` (the per-lane number already on every QR code
       and on the staff dashboard, per ADR-0065)
     - `kind: "called" | "overdue"` (which alert variant to render)
     - a fixed copy id from a small enum (`"called"`,
       `"come-back"`, `"final-warning"`) the SW maps to localised
       strings.
   - **No `nameKana`, no `phoneLast4`, no `appointmentAt` raw
     instant, no shop name.** A push intercepted on the wire (the
     ciphertext is RFC 8291 protected, but the threat model is
     defensive) leaks at most a lane position and a generic copy
     id.

The customer who wants details opens `/ticket` after seeing the
notification; the page rehydrates from `/api/v1/tickets/me` over
TLS + the handle gate (ADR-0069).

## Context

ADR-0054 makes anonymity a hard structural property: the back-end
only ever sees `(nameKana, phoneLast4, ticketId)`. ADR-0073 adds a
new persistent identifier — the Web Push subscription endpoint —
and a new outbound channel — the encrypted push payload. Both are
points where PII could re-leak if the design were sloppy.

Two threats to address:

- **Push subscription as a tracking handle.** A push endpoint is a
  device-stable opaque URL; if we keyed it on the customer handle
  (`(nameKana, phoneLast4) → endpoint`), the push service would
  learn the handle, and a leaked database backup would join handle
  ↔ device. Scoping per ticket (a TypeID minted at issue and
  retired at terminal) keeps the device pseudonym fresh on every
  fresh visit.
- **Push payload as a PII channel.** Putting the customer's name
  in the notification text is a UX temptation ("ヤマダ様、 受付に
  お越しください") that breaks the model. Keeping the payload to
  `displaySeq + copy id` makes the channel structurally incapable
  of carrying a name.

## Trade-offs

| | Handle-scoped subscription | **Ticket-scoped subscription** | Anonymous device id |
|--|--|--|--|
| Persistence across re-issues | yes | **no** (re-subscribe per ticket) | yes (device-stable) |
| Leak surface on backup | handle ↔ device | ticket ↔ device (handle separate) | device id alone (correlation possible) |
| Re-subscription friction | none | **one Notification.requestPermission per ticket** | none |
| Audit story | "we know the customer's devices" | "we know which devices were nudged for this visit" | "we know the device" |

Ticket-scoped is chosen for the strictest unlinking. The
re-subscribe friction is mitigated by the customer's browser
caching the Notification permission (so only the first ticket per
domain shows a prompt) and by the SW reusing the existing
PushSubscription if one is already attached to the page.

## Implementation

### `push_subscriptions` schema

```sql
CREATE TABLE IF NOT EXISTS push_subscriptions (
  ticket_id    TEXT NOT NULL,
  endpoint     TEXT NOT NULL,
  p256dh       TEXT NOT NULL,
  auth         TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (ticket_id, endpoint)
);
CREATE INDEX IF NOT EXISTS ix_push_subscriptions_endpoint
  ON push_subscriptions (endpoint);
```

The DO migration adds this table idempotently alongside the
existing `tickets` / `ticket_events` / `outbox` / `aggregate_snapshots`
tables.

### Lifecycle

- **Insert**: `POST /api/v1/tickets/:id/push-subscription`
  with body `{endpoint, p256dh, auth}`. The endpoint URL is
  validated as `https:` and as one of the known push-service
  origins; anything else 422s.
- **Delete on terminal**: the `Cancelled` / `Served` / `NoShowed`
  projection arm in `projection.ts` already runs server-side; the
  DO repository's `save()` triggers a hook that deletes matching
  `push_subscriptions` rows when the resulting state is terminal.
- **Delete on invalidation**: `sendPush()` returning
  `subscriptionGone` (`404` / `410`) deletes the row by
  `(ticket_id, endpoint)`.
- **Delete on customer request**: `DELETE
  /api/v1/tickets/:id/push-subscription?endpoint=<url>` — the
  customer-side unsubscribe button calls this when permission is
  revoked.

### Payload shape (encrypted)

```jsonc
{
  "v": 1,
  "kind": "called" | "overdue-1" | "overdue-2" | "overdue-final",
  "displaySeq": 47
}
```

- Total bytes (UTF-8, no whitespace): ~38. Well under the 4096
  push-service payload cap and the per-message FCM 4KB limit.
- No timestamp (a stale notification's salience is fine; the
  customer sees "応答をお願いします" and opens `/ticket` for
  detail).
- No ticket id (the SW does not navigate; the customer reopens
  `/ticket` from their bookmark / history / QR).

### Audit / logging

- `sendPush` emits a structured log row
  `{tag: "PushSend", code: "I_PUSH_SEND", ticketId, endpoint:
  <hash-12>, status}`. The `endpoint` is truncated to a 12-char
  SHA-256 prefix so the log is searchable by deployment without
  recording the full opaque URL. ADR-0009 PII discipline is
  unchanged.
- `push_subscriptions` rows are **not** included in the audit
  export endpoint; the export already filters by ADR-0009 PII
  ruleset.

## Consequences

- A customer who issues a fresh ticket each day has a fresh push
  subscription each day. The push service still gets the same
  endpoint URL (the browser reuses it across origins), but the
  back-end's row turns over.
- The push service operator (Google / Mozilla / Apple) can in
  principle correlate endpoints across our domain over time. This
  is unavoidable for any push-based channel; the mitigation is
  not collecting the customer's handle next to the endpoint, which
  this ADR enforces.
- Internal tooling (the audit query for "did this nudge fire?")
  works off the `Nudged` event in the canonical log (ADR-0059), not
  off `push_subscriptions`. The subscription table is a queue
  of "where to send next", not a permanent log.
- A future feature that wants to send a push **to a handle, not a
  ticket** is out of scope; if it becomes desirable, it requires a
  separate ADR and a different schema. The Phase 2 design
  deliberately doesn't open that door.

## Alternatives considered

- **Handle-scoped subscription** (`(nameKana, phoneLast4) →
  endpoint`): rejected; see Trade-offs. The DO would learn a
  stable handle ↔ device pair.
- **Device-id scoped subscription** (`navigator.deviceMemory + UA`
  hash): rejected; reinvents tracking via fingerprinting.
- **Include the kana in the push payload for UX**: rejected; once
  a payload includes a handle, the channel has become a PII
  channel even if encrypted.
- **Skip server-side delete on terminal, let the client unsubscribe
  on next mount**: rejected; ADR-0009 PII TTL applies to the
  subscription too (it's a device pseudonym, weakly identifying).
  The server-driven delete is the authoritative path.

## References

- ADR-0009 — Logging PII discipline.
- ADR-0054 — Customer anonymous handle.
- ADR-0072 — Overdue + nudge loop.
- ADR-0073 — Web Push channel.
- Plan: `/home/yasunobu/.claude/plans/queue-radiant-harp.md`
