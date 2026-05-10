# ADR-0062: Lane partitioning in the queue domain

- Status: Accepted
- Date: 2026-05-09
- Refines: ADR-0050 (queue pivot), ADR-0051 (event-sourced queue), ADR-0052 (type-state Ticket)

## Decision

Every `Ticket` carries a `lane: Lane` value-object where
`Lane = "walkIn" | "priority" | "reservation"`. Sequence
monotonicity (ADR-0051) is **scoped per lane**: the existing
strictly-monotone `seq` continues to grow per-issue across the
entire shop, but FIFO ordering — what a `CallNext` action
consumes — runs **inside a single lane**.

`CallNext` accepts an optional `lane?: Lane` argument. When
omitted, the action consumes the head ticket of the
**preferred-lane chain**: `priority > walkIn > reservation`
(only one ticket is removed, never an interleave). When
specified, the action consumes the head of that lane only and
returns `QueueEmpty` if the lane is empty even when other lanes
are non-empty.

## Context

The pre-pivot queue (ADR-0050) modelled a single FIFO whose
ordering was the global `seq`. Operators in the field reported
three concrete failure modes the single-FIFO model could not
absorb:

1. **Reservation customers arrive ahead of their slot** but should
   wait alongside the walk-in line until their slot, then jump
   to the head — a single FIFO has nowhere to record the deferred
   priority.
2. **Operator wants to surface a VIP / priority customer ahead of
   walk-ins** without manually recalling every ticket between
   them.
3. **Reservation no-shows past their slot** should drift to the
   *back* of the walk-in line, not stay at the head.

The lane partition is the smallest extension that captures all
three: reservations live in their own lane (default consumption
order is *after* walk-in until a reservation-specific
`CallNext{lane: "reservation"}` is fired), priority lives in a
lane that consumes ahead of walk-in, and walk-in is the fall-back.

## Trade-offs

| | Single FIFO | **Lane partition** | Per-customer priority field |
|--|--|--|--|
| Operator can surface a VIP | manual recall chain | `CallNext{lane: "priority"}` | one-shot priority bump |
| Reservation deferral | not modellable | reservation lane sits behind by default | requires per-ticket TTL field |
| Audit trail per lane | no | yes (lane is part of every event) | no |
| Type-state width | 5 states | 5 states × 3 lanes (still 5 typestate) | 5 states × N priority values |
| Migration cost on existing tickets | n/a | one-shot backfill `lane = "walkIn"` | per-ticket migration |
| Domain invariants | seq monotone globally | seq monotone globally + **FIFO scoped per lane** | seq monotone globally + ad-hoc priority comparator |

The lane model wins on operator predictability: the order
between `lane: "priority"` head and `lane: "walkIn"` head is a
*declared policy* (the preferred-lane chain), not a runtime
comparator. Per-customer priority would have given an unbounded
search space; per-lane gives an enumerable one.

## Implementation

- `packages/core/src/domain/queue/Lane.ts` exposes
  `LaneSchema = Schema.Literals(["walkIn", "priority", "reservation"])`
  + `parseLane`. The branding strategy follows ADR-0010
  (value-objects via `brandedString`/`Schema.Literals`).
- `Ticket` common fields gain `lane: Lane`. Existing tickets are
  backfilled to `walkIn`; `Issued` event embeds the chosen lane.
- The DO action `CallNext` becomes
  `CallNext { lane?: Lane; actor }`. The dispatcher's
  `next-to-call` selector consumes lanes in the preferred order
  when `lane` is omitted.
- Projection (ADR-0061's wire shape) gains a `lane: Lane` field
  on every ticket entry; the WS payload version bumps to `v: 2`
  with a forward-compatible `v` discriminator.

## Consequences

- The `seq` on a ticket is no longer the FIFO position the
  customer experiences; the customer's wait-position is the
  count of *active tickets ahead in their lane plus the
  upstream lanes in the preferred chain*. The customer-facing
  page must compute position from the projection, not from `seq`.
- Operators that issue a ticket without specifying a lane get
  `walkIn` (default). The `/issue` form initially exposes no
  lane chooser — lanes are an operator concept. A future
  reservation feature (out of scope here) is the natural place
  to expose `reservation` to customers.
- ADR-0051's "monotone seq across the shop" stays — the
  per-lane FIFO is built *on top* of the global seq, not by
  replacing it.
