# 0035. D1 batch atomicity limits + idempotency-as-rescue

- Status: accepted
- Date: 2026-05-06
- Deciders: Yasunobu
- Tags: cloudflare-d1, atomicity, outbox

## Context

The outbox relay batches the per-event `INSERT INTO booking_events`
and the snapshot `INSERT INTO bookings ON CONFLICT DO UPDATE` into
a single `d1.batch([...])` call. As of 2026-05, Cloudflare D1's
`batch()` runs each statement under autocommit — there is no
ambient `BEGIN/COMMIT` covering the array — so a partial failure
(event INSERT succeeds, snapshot INSERT fails, or vice versa) is
observable.

## Decision

Accept the partial-failure window. The relay relies on
**idempotency** to recover:

- `booking_events.id` is the PK with `ON CONFLICT DO NOTHING`;
  re-inserting the same event is a no-op.
- `bookings.id` is the PK with `ON CONFLICT DO UPDATE`;
  re-inserting the same snapshot row reconciles state.

The outbox row is deleted only after both statements finish; on
any error the row stays in `outbox` with `attempts++` and exponential
backoff. After 6 failures it moves to `outbox_dead` for operator
inspection.

The cluster is therefore **at-least-once eventually consistent**;
for short windows, the D1 mirror may have an event without its
snapshot bump, or a snapshot without the trailing event. Both
states are healed by the next drain attempt.

## Consequences

- **Pros**: no operational dependency on a D1 transaction primitive
  that doesn't exist; the relay is robust under partial failure.
- **Cons**: a `wrangler d1 execute "SELECT * FROM bookings"`
  snapshot taken mid-drain may be momentarily inconsistent with
  `booking_events`. Operators reading the live data should re-run
  the query after a few seconds, or query the DO directly for the
  authoritative state.

## References

- ADR-0028 (DO SQL storage)
- ADR-0029 (EventSourcedRepository)
- `apps/default/src/server/durableObjects/relay.ts`
