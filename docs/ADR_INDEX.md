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
| [0007](./adr/0007-no-handoff-slot-phase0.md)        | Item-handoff is not its own time slot in Phase 0             | accepted |
| [0008](./adr/0008-app-vs-core-layout.md)            | SvelteKit apps in apps/*; core is a pure TS library          | accepted |
| [0009](./adr/0009-logging-pii-discipline.md)        | Logging discipline: PII never appears in any log             | accepted |
| [0010](./adr/0010-forbidden-constructs.md)          | Forbidden TypeScript constructs                              | accepted |
| [0011](./adr/0011-core-distribution-shape.md)       | packages/core distribution shape                             | accepted |
| [0012](./adr/0012-bitmap-slot-calculation.md)       | Slot calculation via bitmap × bitwise AND                    | accepted |
| [0013](./adr/0013-total-state-transitions.md)       | Booking state machine: total transition function             | accepted |
| [0014](./adr/0014-self-validating-booking-code.md)  | Booking code rejected before any database lookup             | accepted |
| [0015](./adr/0015-docker-only-development.md)       | Dev, test, and CI run inside the Docker dev container        | accepted |

## Authoring a new ADR

1. Copy `adr/0000-template.md` to `adr/NNNN-short-slug.md` with the
   next sequential number.
2. Fill in the sections; keep paragraphs short and action-oriented.
3. Add a row to the table above.
4. Open a PR. ADRs are normally accepted on merge; controversial ones
   are landed as `proposed` and flipped to `accepted` once the
   discussion concludes.
