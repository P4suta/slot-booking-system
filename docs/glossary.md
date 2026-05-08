# Glossary

Industry-agnostic vocabulary used throughout `packages/core`. Every
term here is **business-domain neutral** — there are no cars, haircuts,
patients, or pets in this list. Deployments (e.g. the future bikeshop
repo) translate these terms into local UI copy without touching code.

## Core entities

- **Service** — a unit of work the business offers. Carries a duration,
  optional pre/post buffer, optional holding period, required skills,
  required resource types, and a free-text description.
- **Provider** — a person who performs a Service. Has a list of skills.
  Schedule comes from `BusinessHours` minus `Closure` minus
  `ProviderAbsence`.
- **Resource** — a physical thing a Service may occupy: a workspace,
  a storage rack, a treatment chair. Each Resource is a separate
  entity (capacity is expressed by registering N Resources of the same
  `type`).
- **Booking** — a confirmed (or held) reservation that ties a customer
  to a Service, a Provider, zero-or-more Resources, and a TimeSlot.
- **BookingEvent** — an immutable record of a state change on a Booking
  (Held / Confirmed / Cancelled / Rescheduled / Completed / NoShow).
- **AuditLog** — staff-action trail; a separate, longer-retention log
  from BookingEvent. Contains no customer PII.

## Time vocabulary

- **TimeSlot** — `[start, end)` interval bound to a Provider and a set
  of Resources.
- **Buffer (before / after)** — minutes the Provider is unavailable
  immediately before / after the work itself.
- **HoldingDays** — number of days a Resource stays occupied after the
  work is performed (0 = same-day completion).
- **HoldingPeriod** — `[startDate, endDate]` derived from a Booking's
  start date and `HoldingDays`.

## Schedule vocabulary

- **BusinessHours** — open / close times by weekday.
- **Closure** — a date the business is closed (holiday, one-off).
- **ProviderAbsence** — an irregular interval a Provider is unavailable
  (illness, errand). Distinct from BusinessHours.

## Booking lifecycle vocabulary

- **Held** — a 5-minute reservation held while the customer fills in
  the form. Auto-expires.
- **Confirmed** — Held promoted on form submission.
- **Cancelled** — voluntarily ended (by customer or staff).
- **Rescheduled** — time changed; remains Confirmed in the new slot.
- **Completed** — staff marked the work done.
- **NoShow** — staff marked the customer absent.

## Identifier vocabulary

- **BookingCode** — public-facing 7-character code (`XXXX-XXX`,
  Crockford Base32 + mod-37 checksum). The customer sees this; the
  internal `BookingId` is never exposed.
- **TypeID** — internal id of the form `<prefix>_<ULID>`. See ADR-0003.
- **PhoneLast4** — the last four digits of the customer's phone, used
  as a weak authorisation factor.
- **TraceId** — request-scoped correlation id surfaced in logs and HTTP
  headers.

## Bookkeeping

The vocabulary is owned by the core. Adding a term requires updating
this file. Any term that hints at a specific industry (e.g.
"appointment", "ticket", "treatment", "examination", "repair",
"haircut") must not enter the core lexicon — those belong to a
deployment's UI copy only.
