# ADR-0069: Handle as active-set primary key + localStorage cache

- Status: Accepted
- Date: 2026-05-11
- Supersedes: ADR-0064 (customer recovery URL — canonical form with PII)
- Refines: ADR-0054 (anonymous customer handle), ADR-0058 (timing-safe equality)

## Decision

`(nameKana, phoneLast4)` — the anonymous handle from ADR-0054 — is the
**primary key over the active ticket set** `{Waiting, Called, Serving}`
(plus `CheckedIn` as a `Waiting` audit field). The same projection
helper underpins two paths:

1. **`IssueTicket` is idempotent.** A second issue with a handle that
   still holds an active ticket short-circuits to the existing ticket
   — no new id, no second row. The first issue's lane / appointmentAt /
   freeText stay authoritative; caller-supplied values on a merged
   re-issue are dropped.
2. **`GET /api/v1/tickets/by-handle?k&p`** is the customer-side primary
   recovery path. The handle alone — no `ticketId` — resolves to the
   unique active ticket the handle holds. 404 means "no active
   ticket"; the customer is invited to issue.

Terminal states (`Served / Cancelled / NoShow`) release the handle:
a subsequent issue with the same handle mints a fresh ticket.

The DO-local SQLite carries a **partial UNIQUE index** as the physical
safety net:

```sql
CREATE UNIQUE INDEX uq_tickets_handle_active
  ON tickets (name_kana, phone_last4)
  WHERE state IN ('Waiting', 'Called', 'Serving')
```

The web client keeps a `localStorage.queue.ticket.v2` cache with
`(ticketId, nameKana, phoneLast4, cachedAt, lastKnownState?)`. The
cache is **convenience only** — server-side `tickets/by-handle` is
the source of truth — and a stale-while-revalidate boot path renders
from cache, refetches in the background, and purges on terminal
observation or 404.

The `/ticket` URL collapses to **`/ticket?id={ticketId}` only**: no
`k`, no `p`, no PII in the URL bar or browser history. The QR code
on the ticket page encodes the share-safe `/recover` URL — a
recipient scans, lands on the form, and must type the handle to
view.

## Context

ADR-0064 promoted the URL `/ticket?id={ticketId}&k={kana}&p={last4}`
to "canonical recovery": the assumption was that customers keep the
URL in URL bar, sessionStorage, or QR. The trade-off explicitly
accepted PII (kana + last-4) in the URL bar and browser history.

The assumption did not survive contact with reality. Typical
customers who lose the URL — tab close, separate device, site-data
clear — have only their handle: their own name and phone. The
26-char ULID `tkt_…` is not something they wrote down or remember.
ADR-0064's `/recover?id=…` form also required the `id`, so it
could not rescue them either. Result: the design paid the
PII-in-URL cost without buying recoverability.

Parallel structural gaps surfaced:

- **No 2-issue protection.** `IssueTicket` did not check handle
  collision; two issues with the same handle minted two tickets
  with two ids in two lanes if the operator dropped the form
  twice (`packages/core/src/application/usecases/queue/IssueTicket.ts:54-83`).
- **No handle → ticket index.** The customer-side server-side
  primitive to ask "what active ticket is mine?" simply did not
  exist; `GET /tickets/me` required the customer to bring the
  ticketId.

Promoting the handle to the active-set primary key collapses the
three concerns — issue collision, recovery, and URL hygiene — onto
one invariant. The semantics line up: a handle holds at most one
ticket at a time; re-issue is idempotent; recovery is a query over
the same index.

## Trade-offs

| | ADR-0064 canonical URL | ADR-0069 handle-primary |
|--|--|--|
| Recovery requires URL | yes | no |
| Recovery requires ticketId | yes | no |
| Recovery requires handle | yes | yes |
| PII in URL bar | yes (kana visible) | no |
| PII in browser history | yes | no |
| QR shareable | yes (= credential share) | yes (recipient types handle) |
| 2-issue collision | not prevented | merged at use-case + DB |
| Server lookup index | (ticketId) | (kana, last4) partial UNIQUE |
| Brute force on handle | RL_VERIFY 30/min | RL_VERIFY 30/min |

**The active-set primary key is a normalisation choice.** The handle
is NFKC + whitespace-collapsed at the boundary parser (`NameKanaSchema`),
so `「ヤマダ タロウ」` and `「ヤマダ　タロウ」` (full-width space)
hash to the same UNIQUE row.

**Enumeration oracle.** A 200 / 404 split on `/tickets/by-handle`
discloses "kana × last4 is active". The space is roughly
10^4 last4 × 10^4+ plausible kana strings ≈ 10^8+; RL_VERIFY caps
the attacker at 30 / min = 1.5M / year. The honest probabilistic
disclosure of who-is-in-the-queue is acceptable at that rate.

**The QR no longer carries credentials.** A friend who scans the
ticket QR lands on `/recover` and must type the handle. The
"share-via-QR" feature ADR-0064 enabled is intentionally retired
— the use case is rare enough that a future ADR can introduce a
short-lived share token (TTL 24h, capability) if the data demands
it.

**The cache is convenience only.** A device with localStorage
disabled or wiped just falls back to the `/recover` form. The
24h TTL bounds the staleness window.

**`/tickets/me` remains on the server but leaves the public spec.**
The endpoint is reserved for internal use during the one-release
migration window and is removed from `openapi.json`. After one
release cycle with zero callers it will be deleted.

## Implementation

- `packages/core/src/domain/queue/projection.ts` — `isActiveForHandle`,
  `findActiveByHandle`; the latter goes through `equalsCustomerHandle`
  (ADR-0058 constant-time) per element.
- `packages/core/src/application/ports/EventSourcedRepository.ts` —
  `TicketRepository.findActiveByHandle` port method.
- `packages/core/src/application/usecases/queue/IssueTicket.ts` —
  early-return on handle hit; caller observes the existing ticket
  without minting a new id.
- `apps/default/src/server/schema/tickets.ts` — Drizzle
  `uniqueIndex("uq_tickets_handle_active").on(nameKana, phoneLast4).where(...)`.
- `apps/default/src/server/durableObjects/ddl.ts` — DDL renderer
  now emits the partial `WHERE` for indexes whose Drizzle config
  carries one.
- `apps/default/src/server/durableObjects/QueueShop.ts` —
  `getByHandle(handle)` RPC + 201/200 split detection
  (`merged` flag captured from a pre-issue lookup against the
  active set).
- `apps/default/src/server/http/router.ts` — `GET /tickets/by-handle`
  behind `rateLimitMiddleware("RL_VERIFY")`; POST `/tickets` returns
  201 fresh / 200 merged; response carries `merged: true` on the
  merged variant.
- `apps/web/src/lib/ticketCache.ts` (new) — localStorage cache helper
  with TTL + legacy sessionStorage migration.
- `apps/web/src/routes/{issue,ticket,recover}/+page.svelte` —
  cache-driven boot; ticketByHandle as the recovery primitive;
  URL stripped to `/ticket?id`.

## §UX (operations playbook)

The customer-side primitives from this ADR compose into three
operational flows that staff can hand to a confused customer.

### "I lost my ticket / I'm on a different device"

1. The customer goes to **`/recover`**.
2. They type kana + phone last-4 (the handle).
3. The form fires `GET /tickets/by-handle?k&p` and lands them on
   `/ticket?id=...` with the localStorage cache populated.
4. From now on, opening `/` or `/issue` on the same device
   redirects straight to `/ticket` (Stage 8 boot funnel).
5. Browser tab close + reopen survives because the cache lives in
   `localStorage`, not `sessionStorage`.

### "I want to fix my reservation time"

1. The reservation Card on `/ticket` exposes a 「予約時刻を変更」
   button (visible iff the ticket is reservation-laned and
   `state ∈ {Waiting, Called, Serving}`).
2. The Dialog opens with the **current** appointmentAt
   pre-selected in `SlotPicker`.
3. Confirming POSTs to `/tickets/:id/reschedule` (ADR-0070); the
   handle is sent from the cache so the customer never re-types it.
4. Success: the appointment Card's countdown re-reads the new
   slot without waiting for the next WS broadcast.

### "I want to fix my name / phone digits"

This is *not* supported as an in-place edit. The customer is
expected to:

1. Cancel the current ticket (the cancel button on `/ticket`).
2. Reissue from `/issue` with corrected values.

Releasing the handle on cancel + re-acquiring on issue keeps the
active-set primary key invariant (ADR-0069) clean. The
operational pattern is rare enough that staff can read it off the
section above.

### "I want to be alerted when called"

1. While the ticket is `Waiting`, `/ticket` shows a 通知 Card.
2. Tapping 「通知を許可する」 prompts the browser permission flow.
3. On `Called`, the page fires:
   - Web Audio chime (Stage 7)
   - `navigator.vibrate` (mobile)
   - `Notification` API (if the customer granted permission)
4. The alert is **once per `calledAt` instant** — a tab reload
   while `Called` does not re-fire; a staff `Recall → re-Call`
   mints a fresh `calledAt` and the alert fires again.

## Consequences

- The browser URL no longer carries PII. The `meta name="robots" noindex`
  on `/ticket` (ADR-0064 §Consequences) is retained as defence in
  depth; with no PII in the URL the indexing concern is mostly
  moot.
- A customer who hands their phone to a friend can no longer share
  "the URL" as a credential. Sharing the QR works for "scan and
  look at my number" only with the friend typing the handle.
- Multi-ticket per customer (= a parent issuing for a child)
  collapses to a single handle entry — the customer is encouraged
  to use the `freeText` field for the child's name. The active-set
  uniqueness is per-(kana, last4), per-shop, so two truly distinct
  customers with the same kana and last4 cannot both hold a ticket
  at the same time. The collision probability at typical shop load
  is negligible (≪ 1 per shop-day); when it does land, the second
  customer sees a merged response and the staff resolve manually
  (the operator UI surfaces both lanes anyway).
- Multi-tenant: today the DO is keyed by `idFromName("shop")` (one
  shop deployment, ADR-0053). When that lifts, the partial UNIQUE
  index must extend to `(shop_id, name_kana, phone_last4)` — a
  follow-up ADR will own that migration.
- A future ADR can introduce a short-lived share token (capability,
  TTL 24h) if the "share view-only" use case proves load-bearing.
  The token would be a separate primitive from the handle and would
  not relax the URL-PII rule.
- `/tickets/me` is removed from `openapi.json` but kept on the
  server for one release cycle; after that it is deleted.

## References

- ADR-0054 — anonymous customer handle (kana + last4 + ticketId).
- ADR-0058 — timing-safe equality on handles.
- ADR-0064 — customer recovery URL (superseded by this ADR).
- ADR-0066 — slot value object and appointment encoding.
- ADR-0068 — unified issue flow and door QR.
