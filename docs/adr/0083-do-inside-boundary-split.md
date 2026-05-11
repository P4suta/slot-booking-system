# ADR-0083: DO inside-boundary split — Projector / Broadcaster / AlarmScheduler / WsLifecycle / Dispatcher

- Status: Accepted (Parts 1 — 5, complete)
- Date: 2026-05-11
- Stage: C / S11 — S15
- Refines: ADR-0061 (DO hibernating WebSocket projection feed),
  ADR-0053 (single-writer DO), ADR-0075 (delta broadcast)

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

### Part 2 (S12) — `Broadcaster` + per-capability frame variant

Move every broadcast-side concern off `QueueShop`:

- `Broadcaster` class holds two prior-snapshot caches
  (`lastAnon: ShopState | null`, `lastStaff: StaffShopState |
  null`) and a single coalescing timer. `publish()` arms the
  timer; `fire()` builds both variants, advances the shared
  `VectorClock`, and fans out per-socket using the capability tag
  attached at WS upgrade time. Empty diffs on both sides are
  no-op fan-outs (no vector advance, no send).
- WS upgrade goes through the Hono router's `requireStaff` guard
  *before* the DO. On success the router rewrites the URL with
  `?capability=staff`; the DO reads the query, accepts the
  socket with the tag `cap:staff` (`ctx.acceptWebSocket(ws,
  [tag])`), and the Cloudflare runtime preserves the tag across
  hibernation. The fan-out reads `ctx.getTags(ws)` per socket
  and selects the matching payload.
- The staff frame extends each `ProjectionEntry` with the PII
  fields (`nameKana`, `phoneLast4`, `freeText`); the anonymous
  frame stays unchanged. PII is built in `buildStaffShopState`
  and never crosses the anonymous payload boundary —
  `Broadcaster` does not derive one from the other but invokes
  the two builders independently, so a regression that leaks PII
  into the anonymous shape would have to corrupt the builder
  itself.
- Wire `FeedMessage` is now a 4-variant discriminated union over
  `capability ∈ {"anonymous","staff"}` × `kind ∈ {"snapshot","delta"}`.

### Part 3 (S13) — `AlarmScheduler` with `MinHeap` rehydrate

Replace the SQL `MIN(marked_at)` poll with an in-memory binary
min-heap keyed on `deadlineMs = markedAt + GRACE_TTL_MIN`.
`AlarmScheduler` exposes `schedule / cancel / tick / earliestMs`;
the DO's `alarm()` handler is now a 5-line `tick(now) → expired
ids → dispatch(MarkNoShow)` forwarder.

Cold-start rehydrate runs inside `blockConcurrencyWhile` —
`SELECT id, marked_at FROM tickets WHERE state = 'PendingNoShow'`
into a Floyd O(n) build. The heap is purely in-memory: after
hibernation the actor re-runs its ctor and rebuilds from the
persisted projection, so durability stays anchored on the SQL
projection table (ADR-0028).

Lazy delete via a `Set<TicketId>` tombstone keeps `cancel` O(1)
and every `tick`/`earliestActiveMs` peek discards stale heads.
Tombstone size is bounded by the active PendingNoShow set, which
is small in practice — no compaction sweep is needed at this
scale.

The dispatch epilogue maps each `QueueResult` onto a single
scheduler op:

- `result.ticket.state === "PendingNoShow"` → `schedule({
  ticketId, deadlineMs: markedMs + ttlMs, kind:
  "PendingNoShowExpiry" })`
- any other terminal post-state → `cancel(ticketId)` (no-op if
  the id wasn't scheduled).
- `CallBatch` returns `tickets[]`, never PendingNoShow → cancel
  every member.
- `CheckIn`'s void result leaves the heap alone.

`HeapEntry.kind` is the extension point: a future
`"ReservationDeadline"` or `"ServingTimeout"` slots in without
touching the heap structure itself.

### Part 4 (S14) — `WsLifecycle` hibernation-safe adapter

Collapse the DO's four WS hooks (`fetch`, `webSocketMessage`,
`webSocketClose`, `webSocketError`) into a thin
`WsLifecycle.accept` / `handleMessage` / `handleClose` /
`handleError` quartet. The adapter reads `?capability=` off the
upgrade URL, calls `acceptWebSocket(ws, ["cap:<capability>"])`,
wires `setAutoResponse("ping","pong")`, and pushes the initial
snapshot through `Broadcaster.connect`. The QueueShop facade
forwards each hook in one line.

The adapter owns every direct touchpoint to
`wsLifecycleLog` (`logWsAccept` / `logWsClose` / `logWsError`);
the DO does not import the log module anymore. Future
bidirectional WS exchanges (resume-token negotiation, client
ping payloads with vector echo) extend `handleMessage` without
touching the DO.

### Part 5 (S15) — `Dispatcher` + `Persistence/` facade collapse

The DO's `dispatch` is now three lines: handle look-up (for the
`IssueTicket` merge case, ADR-0069), `runDispatch` over the
persistence Layer, and the post-state hook into broadcaster +
scheduler. The Mealy-machine switch (10 actions → 10 use cases →
`QueueResult` shape) lives in `Dispatcher.ts`, where it owns the
`QueueAction` / `QueueResult` types as well. `QueueShop.ts` re-
exports those types for the worker boundary so the migration is
invisible to consumers, while dep-cruiser's `no-circular` holds
(spoke → hub is one-way).

`adapters/DurableObjectTicketRepositoryLive.ts` moves to
`durableObjects/Persistence/repository.ts`; the layer assembly
(`Clock + IdGenerator + TicketRepository + Logger`) lives in
`Persistence/index.ts:persistenceLayer(sql)`. The SQL surface
the worker exposes outside the use-case path (`listTickets`,
`getTicketById`, `getByHandle`, `listDecodedWaitingTickets`,
`lookupActiveIdByHandle`) lives in `Persistence/queries.ts`;
QueueShop's RPC methods are 1-line forwards.

## Status

- 2026-05-11 — All five parts landed (S11 Projector +
  S12 Broadcaster + S13 AlarmScheduler + S14 WsLifecycle +
  S15 Dispatcher + Persistence). `QueueShop.ts` shrank from 706
  lines (S10 baseline) to ~160 lines; the five spokes are each
  independently testable, and `dep-cruise --validate` reports
  zero `no-circular` violations across the new graph.
