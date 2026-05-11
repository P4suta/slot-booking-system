# ADR-0081: CRDT primitives + wire v6 + ShopState semilattice

- Status: Accepted
- Date: 2026-05-11
- Stage: B / S7 + S8 + S9
- Refines: ADR-0061 (DO hibernating WebSocket projection feed),
  ADR-0071 (Projection v4), ADR-0075 (Differential broadcast, v5)

## Decision

### Part 1 (S7) — CRDT primitives + min-heap

Add `packages/core/src/algorithms/` as a vocabulary module for the
classical data structures the lattice-driven projection (S9), wire
envelope (S8), and alarm scheduler (S13) all draw from:

- `MinHeap<T>` — binary heap with caller-supplied comparator,
  Floyd O(n) build, O(log n) push/pop, O(1) peek. Powers S13's
  `AlarmScheduler` (priority = deadline ms) and is reusable for
  any future EDF / coalesce queue.
- `VectorClock` — Lamport / Fidge–Mattern `(siteId → counter)`
  map with elementwise-max merge and the happens-before partial
  order. The v6 wire envelope (S8) carries one per frame so client
  and server can detect snapshot/delta gaps via vector comparison.
- `GCounter` — Shapiro-style grow-only counter, sum-of-slots
  observed value, elementwise-max join. Backs the v6
  `ShopState.laneCounts`.
- `ORSet<T>` — observed-remove set, add-wins under concurrent
  remove via per-add unique tags. Backs the v6
  `ShopState.callableNow` membership view.
- `ORMap<K, V>` — observed-remove map with tag-set per entry,
  pluggable resolver for surviving values. Backs the v6
  `ShopState.tickets` projection.

Each primitive has fast-check property tests pinning the lattice
laws (associativity, commutativity, idempotency of merge) plus the
operation-specific invariants (heap monotone drain, OR-set
add-wins, vector clock antisymmetry / transitivity).

### Part 2 (S8) — wire v6 envelope ★

Replace the v5 envelope (snapshot/delta tagged with `v: 5`) with a
v6 envelope carrying a `VectorClock` and a per-capability tag:

```ts
type FeedFrame =
  | { v: 6, kind: "snapshot",  at: VectorClock, capability, state: ShopState }
  | { v: 6, kind: "delta",     at: VectorClock, since: VectorClock, capability, ops: Operation[] }
  | { v: 6, kind: "heartbeat", at: VectorClock }
```

The `since` field carries the server's prior clock so a client
whose vector is incomparable with `since` knows it has missed a
delta and asks for a snapshot. The per-capability tag (`anonymous`
| `staff`) replaces the prior "REST endpoint for PII" workaround:
staff-token-authenticated sockets receive PII-bearing frames; the
anonymous public landing receives PII-redacted frames.

v4/v5 are fully removed (per user spec — backward compatibility
explicitly waived).

### Part 3 (S9) — ShopState semilattice

`ShopState` becomes a join-semilattice on the algorithms above:

```ts
type ShopState = {
  readonly vector: VectorClock
  readonly tickets: ORMap<TicketId, ProjectionEntry>
  readonly laneCounts: GCounter
  readonly callableNow: ORSet<TicketId>
  readonly nextDeadline: Maximum<InstantOrInfty>
}
```

`ShopState.diff(prev, next)` emits CRDT operations; `merge` is
elementwise lattice join. Replicas converging in arbitrary order
arrive at the same materialised state — the snapshot/delta
race window the prior v5 implementation couldn't structurally
eliminate is closed by the partial-order monotonicity of every
component.

## Context

The v5 delta wire was an ad-hoc per-field diff over a flat record
(`waitingCount`, `laneCounts`, `calling[]`, `serving[]`, `…`).
Adding a new field required updating three places: `compute`,
`apply`, and the `sameLaneCounts` / `sameProjectionEntry` helpers.
The wire couldn't prove that `apply(prev, diff(prev, next)) ≡ next`
in the presence of concurrent updates from different DO replicas —
it was a single-writer assumption baked into the data structure.

Alarm sweeping used `SELECT MIN(marked_at)` for the next deadline
(`QueueShop.scheduleNextAlarm`) — O(n) per call, no priority
queue, no support for multi-kind TTLs (e.g. check-in window
deadlines, future appointmentAt slot reminders).

PII gating used REST-only endpoints (`GET /api/v1/queue` with
staff auth) so the staff dashboard hit REST on every WS delta —
the CQRS-violation pattern S17 will rip out.

## Consequences

- **Pro**: Every lattice law holds by construction — concurrent
  replicas converge regardless of operation order.
- **Pro**: New projection fields land on the existing primitives
  (a new `ORSet` membership view, a new `GCounter`) — no diff /
  apply boilerplate per field.
- **Pro**: AlarmScheduler in S13 reuses MinHeap; future multi-kind
  TTLs (check-in window, ETA buckets) need no scheduler rewrite.
- **Pro**: VectorClock surfaces a structural gap detector to the
  client — "I missed a delta" becomes a typed condition rather
  than a hidden race.
- **Con**: Wire breaking. Server and web ship the v6 change
  together (S8 ships both sides in one commit). v4/v5 receivers
  see decode failures.
- **Con**: New vocabulary (`ORMap` / `ORSet` / `GCounter` /
  `VectorClock`) — readers unfamiliar with CRDT terminology face
  a one-time learning cost. Each primitive's docstring cites
  Shapiro et al. (2011) and the operational shape.

## Follow-ups

- ADR-0083 (S11-S15): Projector / Broadcaster / AlarmScheduler /
  WsLifecycle / Dispatcher modules driven by these primitives;
  per-capability frame fan-out lives in `Broadcaster`.
- ADR-0086 (S18): wire types codegen — once v6 is the only
  envelope, the web's hand-written `Ticket` / `ShopState` aliases
  re-export from `@booking/core` directly.
