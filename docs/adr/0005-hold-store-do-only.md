# 0005. HOLD lives in the Durable Object only — KV is not a hold store

- Status: accepted
- Date: 2026-05-05
- Deciders: Yasunobu
- Tags: infra, concurrency

## Context

A reservation enters the `Held` state for 5 minutes while the customer is filling in the form. SYSTEM.md §3.8 declares the per-day Durable Object as the authoritative store for same-day writes; SYSTEM.md §4.1 also lists a KV namespace `HOLD_STORE_*`. Two stores for one piece of state invites split-brain.

## Decision

- `Held` rows live **inside the DO's SQLite database** with an `expires_at` column.
- The DO schedules a `setAlarm(expires_at)` so the per-day instance wakes up exactly when a hold expires and clears it.
- `KV` is not used for hold state. The remaining KV namespaces (`RATE_LIMIT_STORE`) keep their unrelated purpose.
- `HOLD_STORE_*` bindings are not declared in `wrangler.toml`.

## Consequences

- A single store: same transaction commits both the hold row and the slot bitmap update; expiry is deterministic via the alarm.
- One fewer round trip on the reservation hot path (no KV `get` before checking conflict).
- We trade the KV TTL "for free" cleanup for an alarm-driven sweep — but we needed the alarm anyway to release the slot bitmap.
- Concurrency stays serialised through the DO request queue: no race window between "is this slot held?" and "place a confirmation".

## Alternatives considered

- **DO + KV cache**: cache invalidation between two stores becomes a continual source of drift.
- **KV-only HOLD**: KV has eventual consistency for writes; would invent a custom locking protocol.
- **D1-only HOLD**: D1 has no per-row expiry; would need a separate sweeper.

## References

- SYSTEM.md §2.4, §3.6, §3.8, §4.1.
- Cloudflare DO Alarms documentation.
