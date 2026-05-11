# ADR-0083: DO inside-boundary split — Projector / Broadcaster / AlarmScheduler / WsLifecycle / Dispatcher

- Status: Accepted (Part 1)
- Date: 2026-05-11
- Stage: C / S11 — S15
- Refines: ADR-0061 (DO hibernating WebSocket projection feed),
  ADR-0053 (single-writer DO)

## Decision

Decompose the 706-line `QueueShop` Durable Object into five
inside-boundary modules with a **hub-and-spoke** dependency
topology: `QueueShop` is the only hub that knows the spokes;
spokes never import each other. The DO's external interface
(`dispatch`, `fetch`, `alarm`, `webSocketMessage|Close|Error`)
stays bit-identical so integration tests remain a regression
oracle across the split.

```text
                      ┌───────────────┐
                      │   QueueShop   │  ← hub, ~120 lines facade
                      └───────┬───────┘
            ┌───────┬─────────┼─────────┬───────────┐
            ▼       ▼         ▼         ▼           ▼
       Projector Broadcaster Scheduler WsLifecycle Dispatcher
       (pure)   (coalesce)  (heap)    (adapter)   (switch)
            │              │            │
            ▼              ▼            ▼
              Persistence/ (repository + queries + ledger)
```

Inter-spoke communication is mediated by the hub — e.g.
`AlarmScheduler.tick` returns expired heap entries, `QueueShop`
dispatches `MarkNoShow`, `Broadcaster.publish` then fans the new
projection out. Spokes never call back into the hub or each other,
so dependency-cruiser's `no-circular` rule holds by construction.

### Part 1 (S11) — `Projector` as pure builder + `EncodedTicket` pivot to core

`Projector.buildShopState` is the kernel of the read-model
derivation:

```ts
type ProjectorInputs = {
  readonly tickets: readonly EncodedTicket[]
  readonly decodedWaiting: ReadonlyMap<TicketId, Ticket>
  readonly nowMs: number
  readonly servingThresholdMs: number
}
const buildShopState = (i: ProjectorInputs): ShopState => { … }
```

A plain function — no Effect, no class state, no I/O. The DO
loads inputs (`SqlStorage` rows + `Date.now()` + env config) and
delegates; the function returns the wire payload synchronously.
Unit-testable without a DurableObjectStub.

#### `EncodedTicket` pivot

`EncodedTicket` (= the JSON-safe wire shape) moves from
`apps/default/src/server/durableObjects/QueueShop.ts` to
`packages/core/src/projection/wire.ts`, paired with an
`encodeTicket(t: Ticket): EncodedTicket` helper. The hand-written
discriminated union (`EncodedWaitingTicket | EncodedCalledTicket |
…`) replaces the previous indexed lookup
`(typeof TicketSchema)["Encoded"]`.

**Why hand-written instead of `Schema.Codec.Encoded<typeof
TicketSchema>`:**

- The schema-derived lookup is deeply nested over
  `Schema.Union<readonly [Schema.Struct<…>, …]>`. At the consumer
  side (server / web), `typescript-eslint`'s parser bails out and
  flags every field access as `'Encoded' is an 'error' type that
  acts as 'any'` — the exact failure mode that reverted the prior
  S11 attempt.
- The structural alias resolves identically at every consumer.
  No-circular passes; biome's `useImportType` has no rewriting to
  do; `verbatimModuleSyntax` is untouched.

Schema/structural equivalence is a maintenance burden — the
`encodeTicket` runtime tests cover the round-trip; field
additions to `TicketSchema` surface as runtime decoding failures
in the existing integration tests.

### Parts 2–5 (S12 — S15) — pending

- S12 `Broadcaster` — coalescing window + per-capability frame
  variant (`{anonymous | staff}` payloads, staff PII over WS).
- S13 `AlarmScheduler` — `MinHeap`-backed multi-kind TTL with
  cold-start Floyd O(n) rehydrate from `tickets WHERE state =
  'PendingNoShow'`.
- S14 `WsLifecycle` — hibernation-safe upgrade + lifecycle
  forwarding adapter.
- S15 `Dispatcher` + `Persistence/` — Mealy-machine command
  switch + `repository.ts`/`queries.ts` move from
  `adapters/`.

## Status

- 2026-05-11 — Part 1 (S11 / `Projector` + `EncodedTicket` pivot)
  landed. Parts 2–5 follow in the same sprint.
