# ADR-0077: Duration as branded newtype — phantom-tagged magnitudes

- Status: Accepted
- Date: 2026-05-11
- Stage: A / S1
- Extended-by: ADR-0078 (`Policies` constants land here)

## Decision

Introduce `Duration<K extends DurationKind>` in
`packages/core/src/domain/value-objects/Duration.ts` as the canonical
representation of every wall-clock interval handled by the system —
grace periods, projection thresholds, alarm TTLs, WebSocket keepalive,
broadcast coalesce windows, reconnect back-off.

The carrier is structural — `{ readonly ms: number; readonly kind: K }`
with a `unique symbol` phantom slot — but the kind field acts as the
brand: a `Duration<"Grace">` and a `Duration<"Keepalive">` are
non-interchangeable at compile time. Adding two durations of different
kinds is rejected by `Duration.add`; the type signature insists both
inputs share the same kind parameter.

Construction routes through three intent-revealing helpers
(`Duration.ms`, `Duration.seconds`, `Duration.minutes`) plus a
`Duration.fromTemporal(kind, …)` bridge for the `@js-temporal/polyfill`
path used elsewhere in the codebase. The invariant
"non-negative integer ms" is enforced at the boundary (`make`) — out-of-domain
values raise `RangeError` as a Defect, because every call site in core
constructs durations from compile-time literals or env-derived ints that
are already validated.

`Duration` exposes the operations of a commutative monoid under
`(add, zero)` plus a total order via `compare`, giving every heap key,
EDF lateness comparison, and coalesce-window arithmetic a uniform
algebraic interface. The monoid laws — left/right identity,
associativity, commutativity — are checked under
`fast-check` in `packages/core/test/value-objects/Duration.test.ts`.

## Context

Time magnitudes proliferated across the codebase as bare `number`
literals:

| Constant                          | Location                                                                  | Value           |
|----------------------------------|---------------------------------------------------------------------------|----------------|
| `PROJECTION_GRACE_MS`            | `apps/default/src/server/durableObjects/QueueShop.ts:454`                | `5 * 60 * 1000` |
| `RESERVATION_GRACE_MS`           | `apps/default/src/server/http/router.ts:528` ; `apps/web/.../staff/+page.svelte:94` | same |
| `SERVING_THRESHOLD_MS`           | `QueueShop.ts:485` (env override `SERVING_THRESHOLD_MS \|\| 30_000`)     | 30_000          |
| `GRACE_TTL_MS`                   | `apps/web/.../staff/+page.svelte:106`                                    | `10 * 60 * 1000`|
| `GRACE_IMMINENT_MS`              | `apps/web/.../staff/+page.svelte:107`                                    | `60_000`        |
| `CHECK_IN_WINDOW_MS`             | `apps/web/.../ticket/+page.svelte:78`                                    | `10 * 60 * 1000`|
| `KEEPALIVE_INTERVAL_MS`          | `apps/web/.../api.ts:377`                                                | `30_000`        |
| `BROADCAST_COALESCE_MS`          | DO env / `QueueShop.ts`                                                  | `100`           |

Each value was independently introduced, sometimes with divergent names
for the same magnitude (`PROJECTION_GRACE_MS` ↔ `RESERVATION_GRACE_MS`).
Confusing a server-side `Keepalive` with a client-side `Grace` would
have caused silent timing drift had a refactor pulled them together.

The monoid+order combination matches the requirements of the upcoming
`AlarmScheduler` heap (ADR-0083), where deadlines are computed as
`markedAt + Duration<"PendingNoShowTtl">` and ordered by `compare`.

## Consequences

- **Pro**: Cross-purpose magnitude bugs become compile errors.
- **Pro**: Single bridge to/from `Temporal.Duration` for env-driven
  configuration.
- **Pro**: Property tests pin the algebraic laws; future refactors that
  break monoid associativity (e.g. clamping inside `add`) regress
  loudly.
- **Pro**: Heap / coalesce / EDF algorithms get a uniform `compare`
  interface — no per-call-site comparison code.
- **Con**: New abstraction layer; reading `Duration.toMillis(d)` is one
  symbol more than `d`. Mitigated by the `addToEpoch` convenience.
- **Con**: `DurationKind` enumerates the kinds in core, so adding a new
  kind requires touching this file. This is the desired property — new
  magnitudes should be named purposefully, not introduced anonymously.

## Follow-ups

- ADR-0078 (S2): `Policies` const struct landing in
  `domain/queue/policies.ts`, exposing `GRACE`, `SERVING_THRESHOLD`,
  `PENDING_NOSHOW_TTL`, `BROADCAST_COALESCE`, `WS_KEEPALIVE`,
  `CHECK_IN_WINDOW`, `RECONNECT_INITIAL`, `RECONNECT_CAP` as
  `Duration<K>` values, plus `isCallableNow` as an EDF-lateness lens
  consuming `Policies.RESERVATION_GRACE`. Existing call sites import
  from `Policies`, eliminating the four `isCallableNow` duplicates.
- ADR-0083 (S13): `AlarmScheduler` heap keyed by `Duration` arithmetic.
