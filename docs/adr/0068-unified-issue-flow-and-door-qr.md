# ADR-0068: Unified `/issue` flow + door-QR walk-in entry

- Status: Accepted
- Date: 2026-05-11
- Refines: ADR-0054 (anonymous customer handle),
  ADR-0064 (customer recovery URL),
  ADR-0066 (slot value object + appointmentAt encoding),
  ADR-0067 (time-aware lane chain)

## Decision

There is **one** customer entry route: `/issue`. It exposes:

1. A primary, large **「番号札を取る」** (issue number) button
   that issues a walk-in ticket (no `appointmentAt`).
2. A secondary, collapsed **「▶ 予約する」** (reserve time)
   disclosure that expands a date tab + bucket-time grid; on
   submit issues a reservation ticket with `appointmentAt`.

No separate `/book` route is created. The flow's hierarchy
matches the operational reality of an ordinary number-ticket
shop: walk-in is the dominant interaction; reservation is an
additive feature.

The customer reaches `/issue` from one of three entry points,
all using ADR-0064's canonical URL form for the resulting
ticket:

- **At-home browser** — types or follows a saved link.
- **Door QR signage** — a printed QR code at the shop entrance
  encodes `https://{host}/issue` and is scanned with the
  customer's own phone. **There is no in-store kiosk**; the
  QR is a physical artefact (paper signage), not a code path.
- **Pre-existing QR ticket** — recovery uses ADR-0064
  (`/ticket` or `/recover`).

A reservation ticket additionally surfaces a **「到着しました」**
(check-in) button on `/ticket` once `now ≥ appointmentAt -
10min`, which fires `POST /api/v1/tickets/:id/check-in` and
records a `CheckedIn` audit event. Walk-in tickets do not show
the button — they are implicitly checked in at issue time.

## Context

ADR-0064 hardened recovery for already-issued tickets but did
not extend the *issuance* surface. ADR-0066 introduced the
`appointmentAt` field; ADR-0067 made the reservation lane
time-aware. The remaining customer-facing question is: how
does a fresh reservation enter the system, and how does a
walk-in customer find the system without an in-store kiosk?

Two prior plans were rejected:

1. A separate `/book` route alongside `/issue`. The customer
   has to choose route before knowing what they want; the
   staff has to remember which path each customer took. The
   shop owner's actual ergonomic is "I want a reservation
   system on top of the number-ticket service", which is one
   entry with one optional advanced choice — not two routes.
2. A unified "all reservation; walk-in is the
   `appointmentAt = now` degenerate case" model. This collapses
   the mental model elegantly but inverts the customer's
   labelling ("予約してください" feels colder than "番号札どうぞ"
   for a walk-in shop) and discards the existing PR #11
   walk-in lane semantics.

The chosen shape preserves "walk-in primary, reservation
optional" while integrating both into one form.

## Trade-offs

|  | one route, two paths | two routes (`/issue` + `/book`) | reservation-only |
|--|--|--|--|
| Customer's first decision | tap big button (default) | choose route | pick a slot |
| Walk-in flow | 2 taps + 2 fields | 1 nav + 2 taps + 2 fields | denied / awkward |
| Reservation flow | 1 expand + grid + 2 fields | 1 nav + grid + 2 fields | grid + 2 fields |
| Staff UI surface | unchanged (one Kanban) | unchanged | unchanged |
| Recovery URL (ADR-0064) | one form, all tickets | one form, all tickets | one form, all tickets |
| Door QR | points at `/issue` | points at `/issue` (or `/`) | points at `/book` |
| Code surface | one Svelte page + expand | two Svelte pages | one Svelte page |

The single-route shape minimises both customer cognitive load
and code surface. The disclosure pattern ("▶ 予約する") is
familiar from booking sites and signals "advanced option"
without burying it.

## Implementation

### Customer UI (`apps/web/src/routes/`)

- `issue/+page.svelte`:
  - Top: a large `<button class="primary-cta">` issuing
    walk-in via `POST /api/v1/tickets` with `lane = "walkIn"`
    and `appointmentAt = null`.
  - Below, a `<details>` block containing the date tabs
    (today, tomorrow, day-after) and a CSS grid of bucket
    cells. Available cells are buttons; full cells are
    disabled with `aria-label="満席"`.
  - Bucket data is fetched via
    `GET /api/v1/slots?from&to&granularity` in the load
    function; WS `/queue/feed` updates occupancy in place via
    a Svelte 5 store.
  - On reservation submit, `POST /api/v1/tickets` with
    `lane = "reservation"`, `appointmentAt = bucketStart`.
  - Both submits redirect to ADR-0064's canonical
    `/ticket?id&k&p`.
- `ticket/+page.svelte`:
  - Reservation tickets render `<Countdown />` to
    `appointmentAt` and a check-in button gated by
    `now ≥ appointmentAt - 10min` (the threshold mirrors
    ADR-0067's `EDF_GRACE_MINUTES` default; configurable in
    one place).
  - Walk-in tickets render the existing position + ETA
    (unchanged).

### HTTP (`apps/default/src/server/http/`)

- `router.ts`:
  - `POST /api/v1/tickets` body extends to take optional
    `appointmentAt: string` (ISO Instant). The existing
    `lane?: Lane` field is unchanged; the new boundary schema
    enforces the invariant `lane === "reservation" ⇔
    appointmentAt !== null`.
  - `GET /api/v1/slots?from=&to=&granularity=` returns
    `[ { slot, capacity, taken, available }, … ]`.
  - `POST /api/v1/tickets/:id/check-in` records `CheckedIn`;
    rejects with `CheckInTooEarlyError` if
    `now < appointmentAt - 10min`.
- `boundarySchemas.ts` adds `SlotsQuerySchema` and
  `CheckInBodySchema`; extends `IssueTicketBodySchema`.
- `openapi.ts` reflects the new endpoints and the
  `appointmentAt` / `checkedInAt` fields on `TICKET_SCHEMA`;
  spec version bumps.

### Library

- `apps/web/src/lib/api.ts` adds `listSlots`, `checkIn`;
  `issueTicket` body extends with `appointmentAt`.

### Deployment guide

- `README.md` deployment section gains a one-paragraph "shop
  signage" guide: print the `/issue` URL as a QR (any 2-D
  barcode generator), display at the entrance. **No code
  change, no env var.**

## Consequences

- The customer never has to ask "is this a walk-in shop or a
  reservation shop?" The default action is the walk-in button;
  the reservation expander invites the customer to plan ahead
  if they prefer.
- Reservation customers and walk-in customers share the same
  recovery URL shape (ADR-0064). The QR code on `/ticket`
  encodes the same canonical URL whether the ticket has
  `appointmentAt` or not.
- The shop owner's deployment is unchanged at the code level
  for door-QR adoption — they just print and display the QR.
- Check-in is a customer-side audit event that surfaces actual
  arrival, separate from issue (online booking) and called
  (operator action). Future no-show analytics or late-arrival
  policy has the audit trail it needs.
- The reservation expander on `/issue` adds one paragraph of
  CSS state (the `<details>` open/close); no client-side
  routing change.
