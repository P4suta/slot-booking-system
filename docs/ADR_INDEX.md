# Architecture Decision Records

This directory holds [MADR 4.0](https://adr.github.io/madr/) Architecture
Decision Records. Each file documents one decision; once accepted an
ADR is never edited — it is *superseded* by a later ADR that links
back.

| ADR                                                 | Title                                                        | Status   |
| --------------------------------------------------- | ------------------------------------------------------------ | -------- |
| [0001](./adr/0001-record-architecture-decisions.md) | Record architecture decisions                                | accepted |
| [0002](./adr/0002-booking-code-entropy.md)          | Booking code entropy and encoding                            | accepted |
| [0003](./adr/0003-typeid-prefixes.md)               | TypeID prefix registry                                       | accepted |
| [0004](./adr/0004-temporal-only-no-date.md)         | Time = Temporal only; Date is forbidden                      | accepted |
| [0005](./adr/0005-hold-store-do-only.md)            | HOLD lives in the Durable Object only — KV is not a hold store | accepted |
| [0006](./adr/0006-do-d1-outbox-sync.md)             | DO ↔ D1 sync: Outbox + at-least-once + idempotent            | accepted |
| [0007](./adr/0007-no-handoff-slot-phase0.md)        | Item-handoff is not its own time slot in Phase 0             | superseded by 0050 |
| [0008](./adr/0008-app-vs-core-layout.md)            | SvelteKit apps in apps/*; core is a pure TS library          | accepted |
| [0009](./adr/0009-logging-pii-discipline.md)        | Logging discipline: PII never appears in any log             | accepted |
| [0010](./adr/0010-forbidden-constructs.md)          | Forbidden TypeScript constructs                              | accepted |
| [0011](./adr/0011-core-distribution-shape.md)       | packages/core distribution shape                             | accepted |
| [0012](./adr/0012-bitmap-slot-calculation.md)       | Slot calculation via bitmap × bitwise AND                    | superseded by 0050 |
| [0013](./adr/0013-total-state-transitions.md)       | Booking state machine: total transition function             | accepted |
| [0014](./adr/0014-self-validating-booking-code.md)  | Booking code rejected before any database lookup             | accepted |
| [0015](./adr/0015-docker-only-development.md)       | Dev, test, and CI run inside the Docker dev container        | accepted |
| [0016](./adr/0016-always-latest-releases.md)        | Dependencies and tools track the latest release              | accepted |
| [0017](./adr/0017-error-handling.md)                | Errors as Data.TaggedError with codes, causes, and meta      | accepted |
| [0018](./adr/0018-functional-core-imperative-shell.md) | Functional Core / Imperative Shell — layer purity contract | accepted |
| [0019](./adr/0019-schema-boundary.md)               | Effect.Schema is the boundary-parsing standard               | accepted |
| [0020](./adr/0020-port-tags.md)                     | Application ports as Effect.Context.Tag classes              | accepted |
| [0021](./adr/0021-tsc-references.md)                | tsc Project References for src ↔ test isolation              | accepted |
| [0026](./adr/0026-logger-clock-port.md)             | Logger and Clock port wiring on Cloudflare Workers           | accepted |
| [0027](./adr/0027-day-schedule-durable-object.md)   | Per-day DurableObject + outbox-to-D1 — write-side architecture | superseded by 0053 |
| [0028](./adr/0028-do-sql-storage.md)                | DurableObject SQL storage via drizzle-orm/durable-sqlite     | accepted |
| [0029](./adr/0029-event-sourced-repository.md)      | EventSourcedRepository port + atomic save semantics          | accepted |
| [0030](./adr/0030-do-rpc-either.md)                 | DurableObject RPC methods returning `Either<E, R>`           | superseded by 0037 |
| [0031](./adr/0031-xstate-removal.md)                | Remove the xstate runtime; the transition table is the spec  | accepted |
| [0032](./adr/0032-bitemporal-versioning-row-codec.md) | Bitemporal events + version literal + schema-driven row codec | accepted |
| [0033](./adr/0033-capability-newtype-bloom-removal.md) | Capability newtype + drop the bloom-filter pre-screen      | accepted |
| [0034](./adr/0034-greedy-slot-matching.md)          | Greedy provider/resource matching for AvailableSlots         | superseded by 0040 |
| [0035](./adr/0035-d1-batch-atomicity-limits.md)     | D1 batch atomicity limits + idempotency-as-rescue            | accepted |
| [0036](./adr/0036-schema-source-of-truth.md)        | Schema as the source of truth + Capability stays first-class | accepted |
| [0037](./adr/0037-effect-rpc-do-transport.md)       | `@effect/rpc` over a Cloudflare Durable Object dispatch method | superseded by 0050 |
| [0038](./adr/0038-otel-semconv-unification.md)      | OpenTelemetry semconv unification of Trace · Audit · Log     | accepted |
| [0039](./adr/0039-effect-4-drizzle-1-migration.md)  | Effect 4 + drizzle-orm 1 migration retrospective (Phase 2.2) | accepted |
| [0040](./adr/0040-bipartite-slot-matching.md)       | Bipartite matching for slot resource assignment              | superseded by 0050 |
| [0041](./adr/0041-graphql-functor-migration.md)     | GraphQL functor migration (Pothos → derive/graphql.ts)       | superseded by 0056 |
| [0042](./adr/0042-runtime-mode-port.md)             | RuntimeMode port — env-indexed Layer dispatcher              | accepted |
| [0043](./adr/0043-error-redaction-port.md)          | ErrorRedaction port — cause redaction at the GraphQL boundary | accepted |
| [0044](./adr/0044-do-rpc-envelope-serialization.md) | DO RPC envelope sanitiser — cross-realm structured-clone fix | superseded by 0050 |
| [0050](./adr/0050-queue-pivot.md)                   | Queue pivot — slot-graph reservation → FIFO number-tag queue | accepted |
| [0051](./adr/0051-event-sourced-queue.md)           | Event-sourced queue — ticket_events as the canonical log     | accepted |
| [0052](./adr/0052-type-state-ticket.md)             | Type-state Ticket — discriminated union on `state`           | accepted |
| [0053](./adr/0053-single-writer-do.md)              | Single-writer QueueShop DurableObject                        | accepted |
| [0054](./adr/0054-customer-anonymous-handle.md)     | Customer anonymous handle (nameKana + phoneLast4)            | accepted |
| [0055](./adr/0055-staff-single-capability.md)       | Staff single capability (`operate_queue`)                    | accepted |
| [0056](./adr/0056-hono-router.md)                   | Hono as the queue REST router                                | accepted |
| [0057](./adr/0057-cloudflare-rate-limit.md)         | Cloudflare rate-limit binding for queue mutations            | accepted |
| [0058](./adr/0058-timing-safe-staff-guard.md)       | Constant-time staff token comparison                         | accepted |
| [0059](./adr/0059-event-log-source-of-truth.md)     | Event log is the source of truth + aggregate snapshots       | accepted |
| [0060](./adr/0060-comment-bans-lint-gate.md)        | comment-bans lint gate                                       | accepted |
| [0061](./adr/0061-do-hibernating-websocket.md)      | DO Hibernating WebSocket projection feed                     | accepted |

> ADR-0022 through 0025 are intentionally unallocated (reserved during Phase 0.5
> for proposals that did not survive review).

## Authoring a new ADR

1. Copy `adr/0000-template.md` to `adr/NNNN-short-slug.md` with the
   next sequential number.
2. Fill in the sections; keep paragraphs short and action-oriented.
3. Add a row to the table above.
4. Open a PR. ADRs are normally accepted on merge; controversial ones
   are landed as `proposed` and flipped to `accepted` once the
   discussion concludes.
