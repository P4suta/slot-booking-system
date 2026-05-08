# SYSTEM — booking-system contracts

> Canonical, normative description of what the system is, what it promises,
> and what it refuses to do. ADRs in `docs/adr/` capture each load-bearing
> decision in detail. When SYSTEM and an ADR disagree, the ADR wins (it is
> dated and reviewed); when SYSTEM and the code disagree, fix one of them
> and document why in an ADR.

## What it is

A generic, time-slot-based reservation system for in-person service
businesses. One deployment serves one business; the core code stays
industry-agnostic so future deployments (haircuts, repairs, consultations,
…) can reuse it unchanged. Scale target: tens of bookings per day,
≤ ~10 concurrent users. Standard data retention: 2 years for customer PII,
5 years for staff-action audit logs.

## Iron principles (non-negotiable)

1. **Number-tag model** — no accounts, no logins, no email, no SMS, no
   notifications. Customers remember a `BookingCode` + last-4 phone.
   Reminders are the customer's responsibility (screenshot, paper).
2. **Minimum PII** — collect kana name, phone last 4, service+slot,
   optional free text. Never collect: email, full phone, address,
   birthday, gender, IP, UA, persistent cookies.
3. **Zero external dependencies** beyond Cloudflare. No mail/SMS/auth
   provider, no payments, no monitoring SaaS. The exception is local
   `.ics` generation for customer download (server-built, not sent).
4. **Architecturally impossible double-booking** — concurrency is
   serialised through a per-day Durable Object, not through code-level
   locks.
5. **Customer self-service** — customers cancel and reschedule with
   `BookingCode + phoneLast4`. Staff are not the bottleneck.
6. **Architecture beauty over expedience** (memory-anchored). Type-level
   correctness, total functions, parse-don't-validate, illegal states
   unrepresentable, consistent abstraction levels.
7. **Industry-agnostic vocabulary** in the core. `Service`, `Provider`,
   `Resource` — never `appointment`, `mechanic`, `patient`. Enforced by
   `domain-purity` guard.
8. **Operability is a first-class feature** — runbooks, DR plan, cost
   alerts, audit logs ship with the feature, not after.

## Domain model (summary; see `docs/glossary.md` for vocabulary)

- Entities: `Service`, `Provider`, `Resource`, `Booking`, `BusinessHours`,
  `Closure`, `ProviderAbsence`, `BookingEvent`, `AuditLog`.
- Booking lifecycle: `Held` (5 min TTL) → `Confirmed` → {`Cancelled`,
  `Rescheduled` (back to `Confirmed`), `Completed`, `NoShow`}.
- Provider assignment for "any provider" picks happens at **hold time**,
  deterministically by ascending TypeID. HOLD expiry releases the slot,
  Provider, and Resource together.
- Walk-in / phone bookings are first-class: same `Booking` rows, with a
  `source` field of `online | walkin | phone | staff`.
- Resource capacity is expressed by registering N separate `Resource`
  rows (no `capacity` integer). See ADR-0008 inheritance and the
  glossary.

## Technology choices (all decided; see ADRs)

| Layer                | Choice                                       | Rationale ADR / spec |
| -------------------- | -------------------------------------------- | -------------------- |
| Language             | TypeScript 6, strictest flags ON             | tsconfig.base.json   |
| Runtime (edge)       | Cloudflare Workers (V8 isolates)             | infra                |
| Persistence (auth.)  | Durable Object SQLite (per day)              | ADR-0005, ADR-0006   |
| Persistence (long)   | Cloudflare D1 + Drizzle ORM                  | ADR-0006             |
| Persistence (rate)   | Cloudflare KV (rate limit only)              | ADR-0005             |
| UI / SSR             | SvelteKit 2 + Svelte 5 runes                 | (Phase 1)            |
| Service composition  | Effect (TS) — `Effect`, `Layer`, `Schema`    | ADR-0010             |
| Schema / parsing     | Effect Schema (Effect.Schema)                | ADR-0010             |
| Time                 | `Temporal` polyfill; `Date` forbidden        | ADR-0004             |
| IDs                  | TypeID (`prefix_ULID`)                       | ADR-0003             |
| Booking codes        | Crockford Base32 + mod-37 checksum           | ADR-0002, ADR-0014   |
| Slot calculation     | Bitmap × bitwise AND                         | ADR-0012             |
| Style                | Tailwind v4                                  | (Phase 1)            |
| Test                 | Vitest 4 + fast-check + expect-type + Stryker | (Phase 0/1)         |
| Lint / format        | Biome                                        | biome.json           |
| Dev / CI             | Docker compose `dev` / `ci` stages           | ADR-0015             |

## Out of scope (forever, not just for now)

Reminders / notifications (email, SMS, push), authentication of
customers, payment processing, native apps, third-party calendar
write-back, points / coupons, customer history, inventory, reviews,
recommendations, A/B testing, multi-tenancy, dark/light theme switching,
no-show penalties, automated alerts.

If a request maps to any of those, the answer is "different project".

## Deployment shape

- This repo: `packages/core` (industry-agnostic library) +
  `apps/default` (generic, deployable demo). See ADR-0008, ADR-0011.
- Each real business is a separate repo (e.g. the future
  `bikeshop-booking`) that depends on `@booking/core` and supplies its
  own configuration in `config/services.ts`, `config/providers.ts`, etc.
- Deployment configuration that names a specific industry stays out of
  this repo. The `domain-purity` guard fails the build otherwise.

## Privacy lifecycle

- PII fields (`nameKana`, `phoneLast4`, `freeText`) are nullable.
- A scheduled job NULLs them out 2 years after `Completed`. The
  `BookingEvent` log keeps the audit trail without PII.
- The `AuditLog` table has its own 5-year retention and contains no
  customer PII.

## Verification gates (CI-enforced)

- `tsc --noEmit` strict, every package.
- `biome check` clean, every file.
- C1 branch coverage 100 % over `packages/core/src/{domain,application}`.
- `dependency-cruiser` rules: `core` cannot import `infrastructure` or
  `presentation`; no `cloudflare:`, no `Date`, no `throw` inside
  `domain/` or `application/`.
- `pii-guard` greps for forbidden vocabulary.
- `domain-purity` greps for industry-specific terms.
- Property tests pass 1 000 cases per scenario in `domain/slot/` and
  state transitions.

## Living document

Updates to SYSTEM happen via PR. A change here that contradicts an
existing ADR must include the superseding ADR in the same PR.
