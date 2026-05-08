# SYSTEM — queue contracts

> Canonical, normative description of what the system is, what it
> promises, and what it refuses to do. ADRs in `docs/adr/` capture
> each load-bearing decision in detail. When SYSTEM and an ADR
> disagree, the ADR wins (it is dated and reviewed); when SYSTEM
> and the code disagree, fix one of them and document why in an ADR.

## What it is

A FIFO **walk-in queue** for one in-person service business. One
deployment serves one shop; the core code stays industry-agnostic so
future deployments (haircuts, repairs, consultations, …) can reuse
it unchanged. Scale target: dozens of customers per day, ≤10
concurrent users. Data retention: 2 years for customer PII, 5 years
for staff-action audit logs.

The customer takes a number; the shop sees the queue advance. That
is the entire shape of the product.

The slot-graph framing (time-windowed bookings + provider/resource
matching) was the original design and was scrapped under ADR-0050
once the user reframed the domain as "the customer queues; the shop
sees the queue."

## Iron principles (non-negotiable)

1. **Number-tag model** — no accounts, no logins, no email, no SMS,
   no notifications. The customer holds a `TicketId` plus the
   `(nameKana, phoneLast4)` handle they typed in. Reminders are the
   customer's responsibility (keep the tab open, screenshot the
   ticket).
2. **Minimum PII** — collect kana name, phone last 4, optional free
   text. Never collect: email, full phone, address, birthday,
   gender, IP, UA, persistent cookies. (See ADR-0054.)
3. **Zero external dependencies** beyond Cloudflare. No mail / SMS /
   auth / payment / monitoring SaaS.
4. **Architecturally impossible double-call** — concurrency is
   serialised through the single `QueueShop` Durable Object actor
   (ADR-0053), not through code-level locks.
5. **Customer self-service** — every action a customer needs (issue,
   check position, cancel) lives behind handle verification. Staff
   never types a customer's data.
6. **Beauty over expedience** — the domain is the composition of
   three classical structures (event-sourced log + type-state
   machine + single-writer actor; ADR-0050). New code reuses the
   existing vocabulary or proposes an ADR.
7. **Operations as a feature** — observability (OTel), audit log
   retention, PII purge cron, staff capability gating, and the
   error-codes registry are first-class members of the contract,
   not after-thoughts.

## Domain model

- Aggregate: `Ticket` with a type-state phantom `TicketT<S>` (ADR-0052).
  States: `Waiting | Called | Served | NoShow | Cancelled`.
- Event log: `TicketEvent` (`Issued | Called | Served | NoShowed |
  Cancelled`); the truth is the totally-ordered log, the aggregate
  is the left fold (ADR-0051).
- Identity: `TicketId` is a TypeID `tkt_<ULID>`. Other kinds:
  `TicketEventId`, `StaffId`, `AuditLogId`, `IdempotencyKeyId`.
- Customer credential: `(TicketId, nameKana, phoneLast4)` triple
  (ADR-0054). No session, no cookie.
- Staff credential: single `operate_queue` capability scope
  (ADR-0055), keyed off `STAFF_SESSION_SECRET` via the
  `x-staff-token` header (Phase 4 future-work: scrypt + jose +
  cookie session).

## Lifecycle

```
                     ┌──── Cancel ────┐
                     ▼                │
   Waiting ──Call──→ Called ──Served──→ Served (terminal)
       │                │  ──NoShow──→ NoShow (terminal)
       └─Cancel─────────┴─Cancel─────→ Cancelled (terminal)
```

`Issued` events monotonically pre-allocate `seq` per deployment.
The lowest-`seq` `Waiting` ticket is "next"; the staff "次を呼ぶ"
button picks it. The DO `alarm()` tick fires the no-show TTL sweep
(`Called → NoShow` for `called_at < now - NO_SHOW_TIMEOUT_SECONDS`,
default 300).

## Surfaces

- Customer (apps/web public): `/`, `/issue`, `/ticket`.
- Staff (apps/web token-gated): `/staff` (dashboard).
- API (apps/default REST + SSE):
  - `POST /api/v1/tickets` — issue
  - `GET  /api/v1/tickets/me?ticketId&nameKana&phoneLast4` — myTicket
  - `POST /api/v1/tickets/:id/cancel` — cancel (customer | staff)
  - `GET  /api/v1/queue` — shopState
  - `POST /api/v1/queue/call-next` — callNext (staff)
  - `POST /api/v1/tickets/:id/served` — markServed (staff)
  - `POST /api/v1/tickets/:id/no-show` — markNoShow (staff)
  - `GET  /api/v1/queue/events` — SSE projection feed
- OpenAPI: `/api/v1/openapi.json`.
- Health: `/healthz`.

## Technology choices

| Layer                | Choice                                       | Rationale ADR        |
| -------------------- | -------------------------------------------- | -------------------- |
| Language             | TypeScript, strictest flags ON               | tsconfig.base.json   |
| Runtime (edge)       | Cloudflare Workers (V8 isolates)             | infra                |
| Persistence (auth.)  | DurableObject SQLite (single QueueShop)      | ADR-0053             |
| Persistence (long)   | Cloudflare D1 + Drizzle ORM                  | ADR-0006 (refined)   |
| UI / SSR             | SvelteKit 2 + Svelte 5 runes                 | Phase 5/6            |
| Service composition  | Effect — `Effect`, `Layer`, `Schema`         | ADR-0010             |
| Schema / parsing     | Effect Schema                                | ADR-0010             |
| Time                 | `Temporal` polyfill; `Date` forbidden        | ADR-0004             |
| IDs                  | TypeID (`prefix_ULID`)                       | ADR-0003             |
| Wire format          | REST + JSON + SSE                            | ADR-0050             |
| Lint / format        | Biome                                        | biome.json           |
| Dev / CI             | Docker compose `dev` / `ci` stages           | ADR-0015             |

## Out of scope (forever)

- Multi-shop / multi-tenant. Each deployment is one shop. (ADR-0053
  records this as a permanent non-goal.)
- Time-slot reservation. The slot-graph framing was scrapped under
  ADR-0050; future requests for "let me book 14:00 specifically"
  belong in a different project.
- Provider / resource matching. The customer joins the line; the
  next available staff member serves them.
- Reminders / notifications (email, SMS, push), customer
  authentication beyond the handle, payment processing, native
  apps, third-party calendar write-back, points / coupons, customer
  history, inventory, reviews, recommendations.

If a request maps to any of those, the answer is "different
project".

## Deployment shape

- This repo: `packages/core` (industry-agnostic library) +
  `apps/default` (generic, deployable demo). See ADR-0008, ADR-0011.
- Each real business is a separate repo that depends on
  `@booking/core` and supplies its own configuration. The package
  name is preserved across the queue pivot for continuity (the
  workspace root is still `@booking/core`); the public surface is
  the queue domain.

## Privacy lifecycle

- Customer PII (`nameKana`, `phoneLast4`, `freeText`) is purged from
  the D1 `tickets` mirror 2 years after the ticket reaches a
  terminal state (`Served` / `NoShow` / `Cancelled`). The DO local
  storage carries the same data only for the active day.
- The audit log (5y retention) carries `actor`, `action`, `data` (PII-
  free by construction), `traceId`, and `recorded_at`. PII never
  reaches it; the `pii-guard` CI step rejects the patterns at source.
