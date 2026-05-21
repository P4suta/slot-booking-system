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

The original time-windowed booking design (provider/resource
matching) was scrapped under ADR-0050 once the domain was reframed
as "the customer queues; the shop sees the queue."

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
  States: `Waiting | Called | Overdue | Served | NoShow | Cancelled`
  (ADR-0071 removed `Serving`; ADR-0072 introduced `Overdue` as the
  at-counter timeout window with a bounded nudge loop).
- Lane: each ticket carries a `lane` discriminant (ADR-0062):
  `walk-in | reservation | priority`. Reservation tickets pin an
  `appointmentAt` instant (ADR-0066) and may pass through
  `CheckIn` before `Called` to upgrade EDF priority within
  `grace` (ADR-0067).
- Event log: `TicketEvent` (`Issued | Called | MovedToOverdue |
  Nudged | AppointmentLapsed | Served | NoShowed | Cancelled |
  Recalled | Reordered | CheckedIn | Rescheduled`); the truth is
  the totally-ordered log, the aggregate is the left fold
  (ADR-0051 / ADR-0059).
- Identity: `TicketId` is a TypeID `tkt_<ULID>`. Other kinds:
  `TicketEventId`, `StaffId`, `AuditLogId`, `IdempotencyKeyId`.
- Customer credential: the `(nameKana, phoneLast4)` handle is the
  active-set primary key (ADR-0069). A localStorage cache speeds
  return-visits but the handle alone is sufficient — `/recover`
  resolves the ticket by handle without requiring the `TicketId`.
- Staff credential: a single `operate_queue` capability scope
  (ADR-0055). `POST /api/v1/staff/login` exchanges the deployment's
  `STAFF_SESSION_SECRET` for two surfaces: a short-lived HS256
  JWT (8 h TTL) carried as `Authorization: Bearer <token>` and an
  HMAC-signed `__Host-staff_session` cookie for the staff dashboard.
  The secret-comparison path uses the constant-time comparator
  from ADR-0058 (CWE-208 protection).

## Lifecycle

```text
                          ┌────── Cancel ───────────────────┐
                          ▼                                 │
   Waiting ──CallNext───→ Called ──Served────→ Served (terminal)
      │                     │  ──MarkNoShow─→ NoShow (terminal)
      │                     │
      │                     └─MoveToOverdue─→ Overdue ──Served──→ Served
      │                                          │ ┐     ──NoShow──→ NoShow
      │                                          │ │ Nudge loop ×N
      │                                          │ │ (lastNudgedAt, nudgeCount)
      │                                          │ └─Cancel─────→ Cancelled
      │                                          │
      │                                          └─Recall────→ Waiting
      │
      └─LapseAppointment─→ Cancelled (reason: "appointment_lapsed", reservation lane)
      └─Cancel───────────→ Cancelled (terminal)
```

`Issued` events monotonically pre-allocate `seq` per deployment.
The lowest-`seq` `Waiting` ticket is "next"; the staff "次を呼ぶ"
button picks it. The DO `alarm()` runs a four-tick sweep:

- **Tick 1** `Called → Overdue` for `called_at < now -
  OVERDUE_AFTER_CALLED_SECONDS` (ADR-0071 / ADR-0072).
- **Tick 2** `Overdue → Nudge` (re-fire the customer notification)
  every `NUDGE_INTERVAL_SECONDS` until `nudge_count` reaches
  `MAX_NUDGES`.
- **Tick 3** `Overdue → NoShow` once `nudge_count >= MAX_NUDGES`
  and one more interval has elapsed (no Tick 2 / Tick 3 same-alarm
  collision: strict-inequality cutoffs separate them).
- **Tick 4** reservation-lane `Waiting + appointmentAt + grace <
  now → Cancelled (reason: "appointment_lapsed")` (ADR-0075).

## Surfaces

- Customer (apps/web public): `/`, `/issue`, `/ticket`, `/recover`.
- Staff (apps/web token-gated): `/staff` (Kanban + reservation
  expand, Overdue column).
- API (apps/default REST):
  - `POST /api/v1/tickets` — issue (walk-in or reservation)
  - `GET  /api/v1/tickets/me?ticketId&nameKana&phoneLast4` — myTicket
  - `GET  /api/v1/tickets/by-handle?nameKana&phoneLast4` —
    recovery by handle (ADR-0069)
  - `POST /api/v1/tickets/:id/cancel` — cancel (customer | staff)
  - `POST /api/v1/tickets/:id/reschedule` — reservation reschedule
    (ADR-0070)
  - `POST /api/v1/tickets/:id/check-in` — customer arrival audit
    (ADR-0068)
  - `POST /api/v1/tickets/:id/push-subscription` — Web Push
    register (ADR-0073)
  - `DELETE /api/v1/tickets/:id/push-subscription` — Web Push
    unregister
  - `GET  /api/v1/queue` — shop projection v4 (`waiting[]` /
    `calling[]` / `overdue[]` — ADR-0071 / ADR-0072)
  - `POST /api/v1/queue/call-next` — callNext (staff)
  - `POST /api/v1/queue/call-specific` — callSpecific (staff,
    ADR-0065)
  - `POST /api/v1/queue/call-batch` — callBatch (staff)
  - `POST /api/v1/queue/reorder` — reorder (staff, ADR-0065)
  - `POST /api/v1/tickets/:id/recall` — recall (staff)
  - `POST /api/v1/tickets/:id/served` — markServed (staff)
  - `POST /api/v1/tickets/:id/no-show` — markNoShow (staff)
  - `POST /api/v1/staff/login` — HS256 JWT + signed cookie
  - `GET  /api/v1/queue/feed` — DO Hibernating WebSocket
    projection feed (ADR-0061)
- OpenAPI: `/api/v1/openapi.json`.
- Health: `/healthz`.

## Technology choices

| Layer                | Choice                                       | Rationale ADR        |
| -------------------- | -------------------------------------------- | -------------------- |
| Language             | TypeScript, strictest flags ON               | tsconfig.base.json   |
| Runtime (edge)       | Cloudflare Workers (V8 isolates)             | infra                |
| Persistence (auth.)  | DurableObject SQLite (single QueueShop)      | ADR-0053             |
| Persistence (long)   | Cloudflare D1 + Drizzle ORM                  | ADR-0006 (refined)   |
| UI / SSR             | SvelteKit 2 + Svelte 5 runes                 | apps/web             |
| Service composition  | Effect — `Effect`, `Layer`, `Schema`         | ADR-0010             |
| Schema / parsing     | Effect Schema                                | ADR-0010             |
| Time                 | `Temporal` polyfill; `Date` forbidden        | ADR-0004             |
| IDs                  | TypeID (`prefix_ULID`)                       | ADR-0003             |
| Wire format          | REST + JSON + DO Hibernating WebSocket       | ADR-0050 / ADR-0061  |
| Lint / format        | Biome                                        | biome.json           |
| Dev / CI             | Docker compose `dev` / `ci` stages           | ADR-0015             |

## In scope (post-pivot additions)

The original time-windowed booking design was scrapped under
ADR-0050, but the time axis came back in a different shape:

- **Reservation lane** lives alongside the walk-in queue
  (ADR-0062). Reservation tickets pin an `appointmentAt` instant
  on the `Slot` value object (ADR-0066). EDF promotes the
  reservation head past the static `priority > walk-in >
  reservation` chain when within `grace` (ADR-0067).
- **Web Push notifications** (VAPID, RFC 8291 aes128gcm) are the
  background companion to the foreground WebSocket feed
  (ADR-0073). Subscriptions are ticket-scoped and payload-
  anonymous (`{ v, kind, displaySeq }` only, see ADR-0074); they
  reap on terminal transition and on the push service's 404 / 410.

## Out of scope (forever)

- Multi-shop / multi-tenant. Each deployment is one shop (ADR-0053
  records this as a permanent non-goal).
- Provider / resource matching. The customer joins the line; the
  next available staff member serves them.
- Email or SMS notifications, customer authentication beyond the
  handle, payment processing, native apps, third-party calendar
  write-back, points / coupons, customer history, inventory,
  reviews, recommendations.

If a request maps to any of those, the answer is "different
project".

## Deployment shape

- This repo: `packages/core` (industry-agnostic library) +
  `apps/default` (generic, deployable demo). See ADR-0008, ADR-0011.
- Each real business is a separate repo that depends on
  `@booking/core` (the workspace root) and supplies its own
  configuration. The public surface is the queue domain.

## Privacy lifecycle

- Customer PII (`nameKana`, `phoneLast4`, `freeText`) is purged from
  the D1 `tickets` mirror 2 years after the ticket reaches a
  terminal state (`Served` / `NoShow` / `Cancelled`). The DO local
  storage carries the same data only for the active day.
- The audit log (5y retention) carries `actor`, `action`, `data` (PII-
  free by construction), `traceId`, and `recorded_at`. PII never
  reaches it (ADR-0009).
