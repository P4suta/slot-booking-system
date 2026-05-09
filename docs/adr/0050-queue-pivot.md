# ADR-0050: Queue pivot — slot-graph reservation → FIFO number-tag queue

- Status: Accepted
- Date: 2026-05-08
- Supersedes: ADR-0007 (no-handoff slot Phase 0), ADR-0012 (bitmap slot
  calculation), ADR-0027 (DaySchedule per-day DO), ADR-0034 (greedy slot
  matching), ADR-0040 (bipartite slot matching)

## Context

The slot-graph framing — `Service × Provider × Resource` reservations
serialised through a per-day `DaySchedule` Durable Object, with
`computeAvailableSlots` resolving skill / resource-type matching via
Hopcroft-Karp bipartite matching — was the original design. After
Phase 0-A landed, the user reframed the domain: walk-in customers
queue up; the shop sees the queue advance. Time slots, service
classification, and provider/resource matching add complexity for
features that are not load-bearing in the new framing.

## Decision

Pivot the domain to a **single-shop, single-line FIFO queue**. Customers
hold an anonymous handle (`nameKana + phoneLast4`) and a `TicketId`;
the staff dashboard calls the lowest-`seq` `Waiting` ticket and marks
it `Served`, `NoShow`, or `Cancelled`.

The new domain is the composition of three classical structures
(detailed in ADR-0051 / 0052 / 0053):

1. **Append-only event log + indexed projection (event sourcing)** —
   `TicketEvent` is the totally-ordered fact; `Ticket` is the left fold.
2. **Type-state machine** — `TicketT<S>` parameterises the variant by
   state; the right-side `apply*` helpers accept only the source-state
   they own, so illegal commands fail at the call site, not the runtime
   `InvalidStateTransition` left.
3. **Single-writer Durable Object actor** — one `QueueShop` instance
   per deployment, keyed by `idFromName("shop")`. Concurrency is
   serialised by the actor model; CRDT machinery is rejected because
   there is no second writer to merge against.

The wire surface is REST + SSE rather than the originally planned
GraphQL Yoga — for a five-mutation / two-query / one-subscription
domain, the smaller surface costs ~1/5 the implementation budget while
preserving the same operational profile.

## Consequences

### Removed

- `Service` / `Provider` / `Resource` / `Skill` / `ProviderAbsence` /
  `BusinessHours` / `Closure` entities and their CRUD surfaces.
- Bipartite matching (`bipartite.ts`), bitmap availability
  (`Bitmap.ts`), and the entire `computeAvailableSlots` engine.
- `DaySchedule` Durable Object class (replaced by `QueueShop` under DO
  migration v2 — `deleted_classes = ["DaySchedule"]`).
- `BookingCode` + `slotToken` HMAC (no longer needed: handle alone
  authenticates customer mutations).
- GraphQL Yoga + Pothos surface and the apps/web gql.tada client.

### Reused (rename only)

- `errorEnvelope`, `Cause` algebra and projections, `LogPayload`,
  `TraceId` (ADR-0045 failure-lattice machinery is domain-agnostic).
- `Capability` / `ScopeSet` (single `operate_queue` scope; ADR-0055).
- `application/ports/{Clock,Logger,LogSampler,ErrorRedaction,
  RuntimeMode,AuditLogger,PiiPurger}` ports.
- `infrastructure/{clock,logger,observability}` adapters.
- DurableObject sanitiser (`effectRpc/transport.ts`, ADR-0044).
- `derive/` (Schema → SQL CHECK + OpenAPI projections, generic).

### Operational

- `v2.0.0-pivot.0` is a hard cut; no data migration from `bookings` to
  `tickets`. Existing deployments wipe D1 / DO storage. Documented in
  CHANGELOG and release notes.
- Staff session auth (Phase 4) ships as a `STAFF_SESSION_SECRET`-keyed
  shared header (`x-staff-token`) under ADR-0055; the scrypt + jose
  HS256 + cookie session is recorded as future work.
- Multi-shop deployment is a permanent non-goal (ADR-0053).

## Iron Principles (refined)

The queue domain is in fact a **purer expression** of the original
SYSTEM.md "number-tag model" / "minimum PII" / "zero external deps"
principles than the slot-graph was: no service catalogue, no provider
schedule, no resource inventory, no slot-token signing — the customer
holds a `TicketId`, types the kana + last-4 again to verify, and the
server walks the FIFO order.

## Companion ADRs

- ADR-0051 — event-sourced queue (replay fold, monoid homomorphism).
- ADR-0052 — type-state Ticket (`TicketT<S>` phantom, `applyTyped`).
- ADR-0053 — single-writer DO (`idFromName("shop")`, no CRDT).
- ADR-0054 — customer anonymous handle (`nameKana + phoneLast4`).
- ADR-0055 — staff single capability (`operate_queue` only).
