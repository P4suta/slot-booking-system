# ADR-0078: EDF-lateness lens — one `isCallableNow`

- Status: Accepted
- Date: 2026-05-11
- Stage: A / S2
- Depends-on: ADR-0077 (`Duration<K>`)
- Refines: ADR-0067 (time-aware lane chain)

## Decision

Collapse the three independently-implemented `isCallableNow`
predicates — `QueueShop.shopState`, REST `/queue` handler, and the
staff `+page.svelte` — into a single export from
`packages/core/src/domain/queue/policies.ts`. The predicate's
algebraic form is the EDF (Earliest-Deadline-First) lateness check:

```text
isCallableNow(t, now, grace) ≡
  t.lane ≠ "reservation"               ∨
  t.appointmentAt is null              ∨
  t.appointmentAt parses to NaN        ∨   (defensive — legacy rows)
  parse(t.appointmentAt) − grace ≤ now
```

The companion `Policies` const struct carries every wall-clock
magnitude the system arbitrates with (`RESERVATION_GRACE`,
`SERVING_THRESHOLD`, `PENDING_NOSHOW_TTL`, `BROADCAST_COALESCE`,
`WS_KEEPALIVE`, `CHECK_IN_WINDOW`, `RECONNECT_INITIAL/CAP`) as
`Duration<K>` values (ADR-0077). The lens defaults its `grace`
argument to `Policies.RESERVATION_GRACE` so call sites stay one-arg.

## Context

Three identical implementations existed:

- `apps/default/src/server/durableObjects/QueueShop.ts:454-461` —
  used for the WS projection's `callableNowCount` and the EDF
  partition order in `shopState`.
- `apps/default/src/server/http/router.ts:528-535` — used for the
  REST `/queue` landing-page headline so the anonymous projection's
  callable count matches what staff see.
- `apps/web/src/routes/staff/+page.svelte:94-100` — used to disable
  the 呼び出す button so a stray click can't pull a reservation
  customer to the front 30 minutes early.

All three computed the same expression. Two used
`RESERVATION_GRACE_MS = 5 * 60 * 1000`; the third used
`PROJECTION_GRACE_MS = 5 * 60 * 1000`. The router's comment
explicitly said "Mirrors QueueShop.shopState's `isCallableNow`",
which is the strongest tell that the duplication was load-bearing
and prone to drift.

A future change to the grace window (env override / per-shop policy
/ A/B test) would have required editing three call sites in lockstep;
missing one would have desynced the staff dashboard from the public
landing.

## Consequences

- **Pro**: One source of truth. Changing
  `Policies.RESERVATION_GRACE` updates every callable-now decision,
  staff card enable state, REST headline count, and (post-S9) CRDT
  ORSet membership.
- **Pro**: Web, server, and core share a real import, eliminating
  the "core publishes wire types, web copies them" anti-pattern
  ahead of S18 (schema codegen).
- **Pro**: The `Policies` struct is the conduit for S13's
  AlarmScheduler — TTL is `Policies.PENDING_NOSHOW_TTL` and lives
  next to its EDF cousin.
- **Pro**: Numerical result is bit-identical to the three previous
  implementations, so no integration test moves.
- **Con**: Web now depends on `@booking/core` not just for the wire
  type but for live runtime code. That dependency already exists
  (`applyShopStateDelta`), so this is incremental.

## Follow-ups

- ADR-0079 (S3 + S4): `TicketT<S>` exhaustive phantom; `isCallableNow`
  will gain a narrower input shape (`TicketT<"Waiting">`) once the
  GADT lands.
- ADR-0081 (S7-S9): CRDT `ORSet<TicketId>` of `callableNow` membership
  uses `isCallableNow` to compute membership at delta time.
- ADR-0083 (S13): `AlarmScheduler` keyed on `Policies.PENDING_NOSHOW_TTL`.
