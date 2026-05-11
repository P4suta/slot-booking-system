# ADR-0093: Trigger trace id in `FeedMessage v6`

- Status: Accepted
- Date: 2026-05-12
- Stage: F / S25
- Refines: ADR-0081 (CRDT primitives + wire v6), ADR-0088
  (client obs ring + traceId)

## Decision

Extend every arm of the `FeedMessage v6` union with an
optional `triggerTraceId?: string`. The server-side
broadcaster captures the trace id of the first dispatch
that arms its coalesce timer and bakes it into the
outgoing snapshot / delta; the client decoder relays it
into the obs ring's `WsFrameIn` event so a REST request →
WS broadcast handshake is correlated end-to-end in the
inspector.

```ts
// packages/core/src/projection/shopState.ts
export type FeedMessage =
  | { v: 6; kind: "snapshot"; at: VectorClock; capability: …;
      snapshot: …; triggerTraceId?: string }
  | { v: 6; kind: "delta"; at: VectorClock; since: VectorClock;
      capability: …; delta: …; triggerTraceId?: string }
  | … // four arms, all with the same optional field
```

### Why optional, not a `v: 7` bump

The discriminator literal `v: 6` is shared by all four
arms; adding an optional field is structurally semver-minor
under the existing schema contract. Old clients ignore the
unknown field (TypeScript's structural typing already does
this); missing field is `undefined`. Bumping to `v: 7`
would force a coordinated client + server cutover with
zero observable benefit.

The wire shape stays a single JSON line per `ws.send`; the
existing `X-Trace-Id` response header is for HTTP only —
inventing a parallel WS-header channel to keep wire types
"pure" was rejected because the per-frame attribution
disappears (a long-lived socket sees N frames against one
header).

### First-writer-wins on coalesce

The broadcaster's coalesce timer collapses every publish
inside a 100 ms window into one fan-out. The
`pendingTriggerTraceId` field is set on the first publish
that arms the timer; subsequent publishes inside the same
window inherit the first trigger's id. The semantic
matches the coalesce-arm contract: the first publish is
what *started* the fan-out, so attributing the broadcast
to it lines up with the audit trail.

```ts
publish(triggerTraceId?: string): Promise<void> {
  if (this.pendingTriggerTraceId === undefined && triggerTraceId !== undefined) {
    this.pendingTriggerTraceId = triggerTraceId
  }
  if (this.coalesceTimer !== undefined) return Promise.resolve()
  this.coalesceTimer = setTimeout(…, this.deps.coalesceMs)
}
```

### Trace id source on the server

`QueueShop.dispatch` reads `currentTraceId()`
(`traceIdHeader.ts`) — the helper that re-encodes the
active OTel span's traceId as a Crockford ULID — and
passes it through to `broadcaster.publish(traceId)`. The
helper is documented as "safe to call from any non-Effect
context" including DO methods; OTel context propagates
across the DO RPC boundary inside the same isolate.

For broadcasts that have no inbound request context (alarm
sweep, hibernation rehydrate), `currentTraceId()` returns
`null` and the optional field is omitted from the wire
frame.

### Client decoder

```ts
// apps/web/src/lib/api.ts:connectQueueFeed
obsBus.emit({
  kind: "WsFrameIn",
  capability: env.capability,
  frameKind: env.kind,
  bytes: event.data.length,
  triggerTraceId: env.triggerTraceId ?? null,
  at: Date.now(),
})
```

The inspector's Stream → Detail flow now shows the trigger
trace id alongside the frame metadata; the developer can
search the Ring for the matching `FetchStart` / `FetchEnd`
to see which REST call produced the broadcast.

## Consequences

- Wire compatibility preserved — no `v: 7` bump, no client
  migration step.
- `WsFrameIn.triggerTraceId` is now populated for every
  broadcast that has a request origin; alarm sweeps stay
  `null`.
- The `pendingTriggerTraceId` slot is cleared after every
  fan-out (`fire()`) and after empty-diff no-op fan-outs;
  it never leaks across coalesce windows.
- The Broadcaster's `connect()` (initial snapshot on WS
  upgrade) also takes an optional `triggerTraceId` arg so
  the WS upgrade trace id is attached to the first frame.

## Status

- 2026-05-12 — Schema + broadcaster + client decoder land
  in commit `b3142ba`.
