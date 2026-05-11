# ADR-0074: PendingNoShow grace period (no-show 段階化)

- Status: Accepted
- Date: 2026-05-12
- Refines: ADR-0050 (queue pivot), ADR-0051 (event-sourced queue),
  ADR-0052 (type-state Ticket), ADR-0053 (single-writer DO),
  ADR-0061 (DO Hibernating WebSocket), ADR-0069 (handle as
  active-set primary)
- Supersedes (NoShow alarm semantics): ADR-0063

## Decision

Insert a new intermediate `PendingNoShow` state between `Called`
and the terminal `NoShow` / `Cancelled` exits:

```text
Waiting → Called ─┬─ → Served
                  │
                  ├─ → PendingNoShow ─┬─ → Waiting     (Recall: customer 「遅れる」 walk-in)
                  │                   │
                  │                   ├─ → Waiting     (Reschedule: customer 「遅れる」 reservation)
                  │                   │
                  │                   ├─ → Cancelled   (customer 「来ない」 / staff direct)
                  │                   │
                  │                   └─ → NoShow      (TTL system path)
                  │
                  └─ → Cancelled
```

The staff "来なかった" button no longer terminates the ticket
directly. Instead it opens a grace window of length
`GRACE_TTL_MIN` (env, default 10 min) during which:

1. The customer's web `/ticket` page surfaces the new state and
   offers two responses: 「遅れる」 (which fires `Recall` for
   walk-in / priority lanes, or `Reschedule` for reservation) and
   「来ない」 (`CancelTicket` with `reason="no-come"`).
2. The DO emits Browser Push notifications (ADR-0076 forthcoming)
   reminding the customer of the prompt.
3. If the customer responds with neither before the TTL, the DO
   alarm sweeps the ticket into terminal `NoShow` with
   `actor="system"`.

`MarkNoShow`'s source narrows on intent rather than on the wire:
the use case still accepts `Called | PendingNoShow`, but the
HTTP layer only routes the staff button to `MarkPendingNoShow`
and the alarm sweep targets `PendingNoShow`. A direct
`Called → NoShow` transition is reachable only via the use case
API (system testing path).

Concretely the following are added:

- `PendingNoShow` variant + `PendingNoShowSchema` on `Ticket.ts`
- `PendingNoShowMarkedEvent` on `TicketEvent.ts`
- `applyMarkPendingNoShow` transition + `MarkPendingNoShow` use
  case
- `pendingNoShowTickets(snap, lane?)` projection helper
- `case "PendingNoShowMarked"` in `applyEvent`
- `case "NoShowed"` source widens to `Called | PendingNoShow`
- `case "Recalled"` source widens to `Called | PendingNoShow`
- `case "Rescheduled"` source widens to `Called | PendingNoShow`
- `applyCancel` source widens to `Waiting | Called | PendingNoShow`
- `isActiveForHandle` adds `PendingNoShow` (handle is held)
- DO `QueueAction { type: "MarkPendingNoShow" … }` variant +
  dispatch case
- DO `alarm()` rewritten to sweep PendingNoShow → NoShow on TTL
  expiry (replaces the previous Called-timeout sweep that
  ADR-0063 had specified)
- DO `scheduleNextAlarm()` re-arms after every dispatch + at the
  end of every alarm sweep
- `GRACE_TTL_MIN` env (default 10) — replaces the older
  `NO_SHOW_TIMEOUT_SECONDS`
- `shopState()` payload gains `pendingNoShow: ProjectionEntry[]`
  (anonymous + staff)

The HTTP boundary is intentionally kept minimal in this commit:
the staff `POST /api/v1/tickets/:id/no-show` endpoint is
re-routed to `MarkPendingNoShow` while preserving the URL and
response shape (zero web-client churn). The customer-facing
endpoints `POST /api/v1/tickets/:id/late-acknowledge` and
`POST /api/v1/tickets/:id/no-come-confirm` and the corresponding
web modal land in a follow-on commit alongside ADR-0076's push
notification work.

## Context

The original "来なかった" button (ADR-0063) was an immediate
terminal transition. Field rehearsal exposed three problems:

1. **One-sided contract.** The integer-typed integer 番号 ticket
   is a customer-staff contract. Staff's unilateral
   "you didn't show up — terminated" runs counter to the
   reciprocity that makes 整理券 work as a queue primitive.
   ADR-0072 already established "the ticket number is a stable
   identity"; this ADR extends that principle to lifecycle:
   "no-show is a customer fact, not a staff guess."
2. **No recovery for legitimate delays.** The 5–10-minute "I'm
   in the parking lot" gap was unrecoverable — the customer
   came in, found their ticket cancelled, and had to re-issue
   from the back of the queue. The grace window gives them a
   button to declare "I'm here, just late."
3. **NoShow alarm was idle.** ADR-0063 specified a Called-
   timeout sweep (`NO_SHOW_TIMEOUT_SECONDS`, default 5 min) but
   the DO's `alarm()` was never wired into a `setAlarm` call.
   The grace TTL re-uses the same alarm hook for a now-
   meaningful purpose.

User direction (2026-05-12 plan, AskUserQuestion Q3): "客が
「来ない」 button を押下 + TTL (例 10 分) 自動 cancel". This
ADR encodes that decision plus the structural state-machine
addition needed to support it.

## Trade-offs

| | ADR-0063 (immediate NoShow) | **This ADR (grace period)** |
|--|--|--|
| Customer recovery for legitimate delays | none | walk-in: Recall · reservation: Reschedule |
| Staff click cost | 1 (terminal) | 1 (opens grace) |
| Customer click cost | 0 | 0–1 (modal response) |
| TTL configurability | env-tunable | env-tunable |
| Alarm wiring | specified, not implemented | active (setAlarm on every dispatch) |
| Customer notification | none | Browser Push (ADR-0076) + WS broadcast |
| State machine vertices | 5 (Waiting/Called/Served/NoShow/Cancelled) | 6 (+PendingNoShow) |
| Projection wire bump | n/a | `pendingNoShow[]` field added (no version bump; field is additive) |
| Audit-log shape | `Called` → `NoShowed` (1 event pair) | `Called` → `PendingNoShowMarked` → `NoShowed`/`Cancelled` (2–3 events; richer history) |

The trade-off is a more talkative event log for materially better
customer outcomes and operator-customer reciprocity. Per ADR-0059
the event log is the source of truth — adding more events to it
is the path of least surprise.

## Consequences

- The DO `alarm()` is now load-bearing — every PendingNoShow
  ticket arms the alarm to the next earliest `markedAt + TTL`.
  The alarm fires at most once per TTL boundary; concurrent
  PendingNoShow tickets get swept in a single fire.
- `isActiveForHandle` now includes `PendingNoShow`, so the
  handle is held until either `Cancelled` (customer 「来ない」),
  `NoShow` (TTL expired), or `Waiting` (customer 「遅れる」). A
  re-issue with the same handle while in PendingNoShow returns
  the existing ticket — the customer cannot accidentally double-
  issue while their original is in grace.
- The active-set partial UNIQUE index on
  `(name_kana, phone_last4)` widens its `WHERE` clause to
  `state IN ('Waiting', 'Called', 'PendingNoShow')`. The
  `ensureDurableObjectSchema` migration writes the new index
  shape on next DO boot; SQLite drops the prior index in place.
- `GRACE_TTL_MIN` replaces `NO_SHOW_TIMEOUT_SECONDS`. The old
  env name is no longer read; deployments setting it should
  migrate (the dev seed uses the new name).
- The customer-facing modal + push notifications (Service Worker
  registration, VAPID key handling, subscription storage) are
  the scope of a follow-on commit alongside ADR-0076. The
  current commit lands the state machine + DO infrastructure +
  staff button re-routing only; the customer side will see the
  new state on `/ticket` once that follow-on lands.
- Property tests in `packages/core/test` cover the new
  transitions; the projection's monoid-homomorphism property
  test (`replay(xs ++ ys) = applyMany(replay(xs), ys)`) extends
  to the new event type without modification because the new
  `applyEvent` cases follow the same idempotent /
  state-narrowing pattern as the existing ones.

## Alternatives considered

- **Single staff button "delete this ticket".** Rejected — the
  one-sided contract concern is the whole point of this ADR.
- **Configure ADR-0063's Called-timeout sweep + add a customer
  modal on top.** Rejected — the alarm timing was unreliable
  (5 min from `calledAt`, not from staff abandonment), and the
  customer modal had no anchor event to surface from. The
  PendingNoShow event makes the trigger explicit and audit-
  recoverable.
- **Skip the alarm; staff sweeps PendingNoShow manually.**
  Rejected — operator burden equivalent to the original
  problem. The TTL is the whole point.

## References

- ADR-0063 — Serving state + NoShow alarm cutoff (the alarm
  semantics section is now superseded; ADR-0073 dropped the
  Serving state itself).
- ADR-0072 — Ticket-number identity persistence (sibling
  reciprocity decision).
- ADR-0076 — Browser Push API for grace-period notifications
  (forthcoming; this ADR specifies the trigger and TTL, that
  one specifies the delivery channel).
