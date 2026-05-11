# ADR-0065: Operator-grade queue actions (CallSpecific / CallBatch / Reorder)

- Status: Accepted (Reorder portion withdrawn 2026-05-12 by ADR-0072)
- Date: 2026-05-10
- Refines: ADR-0050 (queue pivot), ADR-0051 (event-sourced queue),
  ADR-0052 (type-state Ticket), ADR-0059 (event-log SoT),
  ADR-0062 (lane partitioning), ADR-0063 (Serving state)
- Superseded for Reorder by: ADR-0072 (ticket-number identity persistence)

> **Note (2026-05-12).** Sections referencing `Reorder` /
> `Reordered` / `applyReorder` / `rebalanceLane` /
> `ReorderedEventSchema` / `POST /api/v1/queue/reorder` are
> withdrawn per ADR-0072. The `CallSpecific` and `CallBatch`
> portions of this ADR remain in force. The original text is kept
> below as the historical record of the introduction; consult
> ADR-0072 for the current `displaySeq` contract (append-only,
> per-lane gaps allowed).

## Decision

Three operator-grade actions extend the lane-aware queue (ADR-0062)
beyond `CallNext`:

1. **`CallSpecific { ticketId; actor }`** — call a specific
   `Waiting` ticket regardless of lane / FIFO position.
2. **`CallBatch { ticketIds: NonEmpty<TicketId>; actor }`** — call
   N waiting tickets atomically (DO single-writer transaction);
   each member produces its own `Called` event sharing a single
   freshly-minted `BatchId`.
3. **`Reorder { ticketId; afterTicketId: TicketId | null; actor }`**
   — move a `Waiting` ticket to a new position **within its lane**;
   `afterTicketId === null` means "lane head".

A new `displaySeq: number` field is added to ticket common fields
as the **per-lane FIFO position** consumed by the projection's
queue order. `seq` (ADR-0051's globally-monotone counter) remains
unchanged and is the audit / total-order anchor; `displaySeq` is
the operator-controlled per-lane order. Issue assigns
`displaySeq = (lane 内 max displaySeq) + 1`. Reorder rebalances
lane 内 displaySeq to a contiguous `1..N` after moving the target.

A new entity kind `BatchId` (`bch_<TypeID>`) joins
`ENTITY_KIND_TAG` so batch members can be recovered via
`events.filter(e => e.type === "Called" && e.batchId === b)`.
`CalledEventSchema` gains an optional `batchId?: BatchId` (absent
on CallNext / CallSpecific, present on CallBatch).

## Context

ADR-0062 introduced lane partitioning + `CallNext { lane? }`.
ADR-0063 added the `Called → Serving` split with NoShow alarm
restricted to `Called`. Three operator workflows remain unmodelled:

1. **Specific call** — a named-complaint VIP arrives, the operator
   needs to call them now; manually recalling every walk-in
   between the head and the VIP is the current workaround and is
   audit-noisy.
2. **Burst call** — at lunch-rush exit four customers leave at
   once; the operator wants one click to call four, atomic, with
   one audit grouping.
3. **Per-lane reorder** — a reservation customer arrives 30 min
   before slot and waits politely; mid-shift the operator wants
   to slip them ahead of two newer reservation tickets within the
   reservation lane (or vice versa for walk-in courtesy).

Each is a *named operator intent* the audit log should record by
name, not as a polymorphic `QueueOp { kind: "..." }` payload —
the action surface stays small (10 actions total: Issue, CallNext,
CallSpecific, CallBatch, StartServing, MarkServed, MarkNoShow,
Recall, Cancel, Reorder).

## Trade-offs

| | CallNext only | **Three named actions** | One generic `QueueOp` |
|--|--|--|--|
| Specific call | recall chain | 1 click | 1 click + tag |
| Batch call | N clicks | 1 click, atomic | 1 click + tag |
| Reorder | not modellable | yes (per-lane rebalance) | yes |
| Audit clarity | high | high (action = intent) | low (one type, payload tag) |
| Type-state surface | 5 actions | 8 actions | 1 action + 8 tags |
| `displaySeq` need | none | yes | yes |
| Wire schema | smallest | branded + per-action | branded + tagged union |

The named-action shape wins on audit clarity and type-state
narrowing: `applyCall(t: Waiting, …)` covers all three call paths
because the use-case is structurally identical (Waiting → Called),
while the *intent* lives in the action name in the dispatcher
rather than in the transition signature. `Reorder` is its own
transition because no other action mutates `displaySeq`.

`displaySeq` lives on every ticket variant (not just Waiting) so
projections can render the historical lane order in the staff
"Done (last 8)" column — a Served ticket retains the
`displaySeq` it had at the moment of MarkServed.

## Implementation

### Domain (`packages/core/src/domain/`)

- `types/EntityId.ts`:
  - `ENTITY_KIND_TAG` gains `bch: "BatchId"`.
  - `BatchIdSchema`, `BatchId`, `parseBatchId`, `newBatchId`
    follow the existing per-kind alias pattern.
- `queue/Ticket.ts`:
  - `CommonFields` gains `lane: Lane` and `displaySeq: number`.
  - `ServingSchema` (per ADR-0063) joins the `TicketSchema` union.
  - `TerminalTicketState` is unchanged (`Serving` is active).
- `queue/Lane.ts` (new) declares `LaneSchema = Schema.Literals(["walkIn", "priority", "reservation"])`,
  `ALL_LANES`, and the preferred-lane chain
  `["priority", "walkIn", "reservation"]`.
- `queue/transitions.ts`:
  - `applyCallNext` is renamed `applyCall(t: Waiting, args)` —
    the same right-side helper handles all three call paths
    (CallNext head, CallSpecific by-id, CallBatch member). The
    `args` object accepts an optional `batchId?: BatchId`.
  - `applyStartServing(t: Called, …) → ApplyResult` (Called → Serving).
  - `applyMarkServed(t: Called | Serving, …) → ApplyResult`
    (the Served variant carries `calledAt + calledBy` from
    whichever source state, plus optional
    `servingStartedAt + servingStartedBy` when the source was
    `Serving`).
  - `applyMarkNoShow(t: Called, …)` source narrows to `Called`
    only (per ADR-0063).
  - `applyReorder(t: Waiting, args) → ApplyResult` produces a
    `Reordered` event; the resulting Waiting ticket is structurally
    identical to the input (`displaySeq` is rebalanced by the
    projection, not by this helper, because rebalancing requires
    visibility of all lane peers).
  - `guardActive` classifies `Serving` as active.
  - The `TicketCommand` literal grows to
    `"CallNext" | "CallSpecific" | "CallBatch" | "MarkServed" | "MarkNoShow" | "Cancel" | "Recall" | "StartServing" | "Reorder"`.
- `queue/TicketEvent.ts`:
  - `IssuedEventSchema` gains `lane: Lane` + `displaySeq: number`.
  - `CalledEventSchema` gains optional `batchId?: BatchId`.
  - `ServingStartedEventSchema` (new):
    `{ ticketId, servingStartedAt, servingStartedBy }` (event-base
    fields inherited).
  - `ReorderedEventSchema` (new):
    `{ ticketId, afterTicketId: TicketId | null, reorderedBy }`.
  - `ServedEventSchema` keeps its shape but the projection
    handles a `Serving`-source MarkServed by carrying through the
    Serving fields.
- `queue/projection.ts`:
  - `head(snap, lane?)` returns the lowest-`displaySeq` Waiting
    ticket in the given lane, or in the preferred-lane chain
    `priority > walkIn > reservation` when `lane` is omitted.
  - `serving(snap)` returns
    `ReadonlyArray<{ ticket: Serving; …}>` (no longer single).
  - `applyEvent` `Issued` records `displaySeq = event.displaySeq`
    + `lane = event.lane`.
  - `applyEvent` `Called` carries `batchId` through the snapshot
    only via the audit log; the `Called` ticket does not store
    `batchId` (it is event-scoped, not ticket-scoped).
  - `applyEvent` `ServingStarted` migrates `Called → Serving`.
  - `applyEvent` `Reordered` rebalances lane 内 Waiting ticket
    `displaySeq` to `1..N` after re-inserting the target after
    `afterTicketId`.

### Application (`apps/default/src/server/`)

- `durableObjects/QueueShop.ts` `QueueAction` grows to 10 variants
  (Issue, CallNext, CallSpecific, CallBatch, StartServing,
  MarkServed, MarkNoShow, Recall, Cancel, Reorder).
- `IssueTicket` accepts an optional `lane?: Lane` (default
  `"walkIn"`); `displaySeq` is computed from the in-memory
  projection at dispatch time.
- `CallBatch` runs N appends in one SqlStorage transaction; each
  Called event embeds the same fresh `batchId`. Failure in any
  member rolls back the whole batch.
- The DO action selector for `CallNext` consumes the preferred-
  lane chain when `lane` is omitted, the named lane otherwise.

## Consequences

- The customer's wait position is computed from `displaySeq +
  upstream lane sizes`, not from `seq`. The customer-facing
  `/ticket` page reads position from the projection, not from
  the `seq` attached to the ticket.
- `seq` remains globally monotone (ADR-0051), still authoritative
  for cross-lane total order in audits and event-id minting.
- Reorder is restricted to `Waiting`; UI guards re-arrangement of
  Called / Serving / terminal tickets (an attempted reorder of a
  non-Waiting ticket returns `InvalidStateTransitionError`).
- The audit log can recover a CallBatch as
  `events.filter(e => e.type === "Called" && e.batchId === b)`;
  no separate `BatchCalled` event is needed.
- The existing NoShow alarm filter (`state === "Called"`) remains
  correct (Serving is invisible to it, per ADR-0063).
- Backfilling: existing tickets carry `lane = "walkIn"` and
  `displaySeq = seq` at the migration boundary; per-lane `seq`
  growth is monotone in production from day one of this redesign,
  so the backfill is one-shot and final.
