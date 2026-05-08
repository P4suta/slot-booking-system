# ADR-0054: Customer anonymous handle

- Status: Accepted
- Date: 2026-05-08

## Decision

Customers authenticate with the triple `(TicketId, nameKana,
phoneLast4)`. There is **no session, no cookie, no account**. The
worker stores nothing about the customer beyond that triple plus an
optional `freeText` (the customer's own description of their visit).

The `TicketId` arrives at the customer through the `/issue` form's
redirect to `/ticket#id=<TicketId>`. The browser persists the triple
in `sessionStorage` so the ticket panel re-authenticates on every
SSE re-connect; the URL fragment (`#id=...`) never reaches the
worker logs.

Mismatched handles fail with `PhoneMismatchError`. The error
deliberately does not distinguish "wrong nameKana" from "wrong
phone last 4" so an attacker who knows one cannot probe the other.

## Consequences

- The Iron-Principles minimum-PII rule is preserved: the worker
  collects exactly what the queue surface needs to verify the
  customer's claim of ownership.
- Reminders are the customer's responsibility (screenshot the
  ticket panel; keep the tab open). No SMS / email / push.
- The handle-mismatch defence is intentional and must not be
  weakened in future iterations; surfacing finer-grained errors
  would convert the queue into an enumeration oracle for whichever
  factor stayed correct.
