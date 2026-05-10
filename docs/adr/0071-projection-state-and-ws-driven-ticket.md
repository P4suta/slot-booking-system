# ADR-0071: Projection v4 — state on every entry, cap removed

- Status: Accepted
- Date: 2026-05-12
- Refines: ADR-0061 (DO Hibernating WebSocket projection feed)

## Decision

The DO WebSocket broadcast / `GET /api/v1/queue` projection bumps
to **v4** with two narrow changes:

1. Every `ProjectionEntry` carries `state: TicketState` (Waiting /
   Called / Serving / Served / NoShow / Cancelled).
2. `waitingPreview` exposes **every** Waiting ticket; the prior
   `slice(0, 10)` (anonymous) and `slice(0, 20)` (staff) caps are
   dropped.

Customer identifying fields (`nameKana`, `phoneLast4`, `freeText`)
remain staff-only on the anonymous path. The "anonymous projection
only" decision from ADR-0061 is preserved as **PII-only-not-public**
— `state` is public information already visible on the in-store
monitor, so its presence on the WS feed does not weaken the
privacy posture established by ADR-0061.

## Context

ADR-0061 minted the DO Hibernating WebSocket and described the
broadcast as "the anonymous projection only". The implementation
took that literally and dropped `state` from `ProjectionEntry`
along with PII. The customer-facing `/ticket` page therefore had
no way to read its own state from the WS feed and resorted to
calling `ticketByHandle()` (rate-limited by `RL_VERIFY`,
30 / min / IP) on every broadcast it received.

Under realistic load this becomes a UX-blocker:

- A staff member who fires `CallNext / MarkServed / Recall` five
  times in a minute multiplies into N customer tabs × 5
  broadcasts × 1 HTTP call each. A single customer who sits on
  `/ticket` while the staff works through the line easily
  exhausts the 30 / min budget without doing anything themselves.
- The user-reported symptom: "I clicked around on the same page
  and got rate-limited." The customer never left `/ticket`. The
  protection misfires on honest traffic.

The `waitingPreview` slice cap had a related limitation: a
customer in the 11th-or-later position fell out of the projection
entirely, so even with `state` on the wire their position would
not be discoverable from WS alone.

`state` is public information. The in-store monitor displays
which numbers are currently being called and served. The staff
Kanban already broadcasts the lane assignments. Treating `state`
as PII was overcautious — ADR-0061's intent was to keep
identifying handles off the wire, not to occlude operational
status.

## Trade-offs

|                                | ADR-0061 (v3)        | ADR-0071 (v4)         |
|--------------------------------|----------------------|-----------------------|
| `state` on broadcast           | no                   | yes                   |
| Identifying handle on broadcast| no                   | no                    |
| `waitingPreview` cap           | 10 / 20              | full                  |
| HTTP per WS tick on `/ticket`  | one `ticketByHandle` | zero (steady state)   |
| RL_VERIFY budget for honest UX | tight (~10 ticks)    | comfortable           |
| Brute-force budget for attackers| 30 / min            | 30 / min (unchanged)  |

**Payload size.** A `ProjectionEntry` is ~80 bytes serialised
(id 26, seq 4, lane 12, displaySeq 4, appointmentAt 24, state 8).
100 waiting tickets puts `waitingPreview` at ~10 KB; 1000 puts it
at ~100 KB. The current deployment targets a single-shop scale
where the practical ceiling is in the low hundreds, so the
broadcast stays well under the round-trip cost of a single
HTTP+JSON exchange. A throttling or differential-broadcast
scheme is in scope for a future ADR if a deployment crosses that
threshold; this ADR explicitly defers that work and notes the
escape valve.

**`checkedInAt` is intentionally not added.** It is per-ticket
private state and not displayed on the in-store monitor. The
customer-side check-in flow uses an optimistic local update so
no HTTP fetch is needed in the happy path; the server-assigned
value would only matter on a recovery path (`/recover` boot), at
which point the boot HTTP already pulls it.

**`calledAt` is also kept off.** A Called transition is rare
enough (≤ 1 per ticket lifetime, +1 per Recall) that one HTTP
fetch when the transition is observed in WS is acceptable. That
follow-up lets the chime / vibrate / notification (Stage 7) read
the server's authoritative `calledAt` for replay protection.

## Implementation

- `apps/default/src/server/durableObjects/QueueShop.ts` —
  `project()` grows `state`, `waitingPreview = waiting.map(project)`
  (no slice), `v: 4`.
- `apps/default/src/server/http/router.ts` — `GET /api/v1/queue`
  applies the same change to both anonymous and staff branches;
  staff `waitingPreview = waiting` instead of `waiting.slice(0, 20)`.
- `apps/web/src/lib/api.ts` — `ProjectionEntry` gains `state`,
  `ShopState` / `StaffShopState` bump to `v: 4`.
- `apps/web/src/routes/ticket/+page.svelte` — `onProjection`
  looks for the ticket id in the three lane buckets and merges
  state / lane / displaySeq / appointmentAt into the local
  ticket. HTTP `refresh()` is only invoked on:
  1. a fresh `Waiting → Called` transition (to read the
     server-assigned `calledAt`)
  2. an active id falling out of every bucket (to confirm the
     terminal state and purge the cache)
- `onCheckIn` flips `checkedInAt` optimistically and reverts on
  failure; no follow-up HTTP.
- `onRescheduleConfirm` drops its trailing `refresh()` — the
  server emits a projection broadcast as part of the mutation
  pipeline.
- `apps/default/test/integration/property/queueFlow.property.integration.test.ts`
  — the invariant changes from `waitingPreview.length ≤ 10` to
  `waitingPreview.length === waitingCount`, and every entry
  carries `state === "Waiting"` in the public projection.

## Consequences

- The 30 / min RL_VERIFY budget is now entirely available for
  the path it was designed for (handle brute-force defence,
  ADR-0069 §Trade-offs). Honest customer tabs consume zero
  budget while sitting on `/ticket`.
- `/staff` Kanban renders the full waiting queue in
  `waitingPreview` instead of only the first 10 / 20. The
  filter + accordion in `/staff` (Stage B of this sprint) is
  the visual offset for the longer list.
- ADR-0061's "anonymous" promise stays intact for PII; the
  refined wording is "PII-only-not-public". Future projection
  changes go through the same lens: does the field appear on a
  public surface (in-store monitor, staff-facing Kanban broadcast
  to customers)? If yes, it can ride the wire; if no, it stays
  staff-only.
- Customers in waiting position 11+ now appear in the projection
  and can have their position rendered. The "あなたの前に N 人"
  hint on `/ticket` becomes reliable across the entire queue
  length.

## References

- ADR-0061 — DO Hibernating WebSocket projection feed (the wire
  contract refined here).
- ADR-0069 — Handle as active-set primary key (the source of
  the `RL_VERIFY` budget whose protection role was being
  diluted).
- ADR-0070 — Reservation reschedule (a mutation that emits a
  projection broadcast; A-3 removes the redundant client-side
  HTTP refresh that mirrored it).
