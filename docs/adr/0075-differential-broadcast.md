# ADR-0075: Differential broadcast (delta envelope, wire v5)

- Status: Accepted
- Date: 2026-05-12
- Refines: ADR-0061 (DO Hibernating WebSocket), ADR-0071 (Projection v4)

## Decision

Bump the WebSocket projection wire from "raw v4 ShopState JSON on
every dispatch" to a **v5 envelope** that carries either a full
snapshot or a per-field delta:

```ts
type FeedMessage =
  | { v: 5, kind: "snapshot", snapshot: ShopState }
  | { v: 5, kind: "delta", delta: ShopStateDelta }
```

The DO holds the last broadcast snapshot in memory; on every
dispatch epilogue it (a) coalesces consecutive dispatches inside
a `BROADCAST_COALESCE_MS` window (default 100 ms), then (b) diffs
the new snapshot against the cached one and broadcasts only the
delta. New connects (`sendProjectionTo`) always receive a full
snapshot so the client has a baseline to merge against.

Concretely:

- New core module `packages/core/src/projection/shopState.ts`
  exports `ShopState` / `ShopStateDelta` / `FeedMessage` + the
  pure helpers `computeShopStateDelta` / `applyShopStateDelta` /
  `isEmptyShopStateDelta`.
- `QueueShop.broadcastProjection` becomes a debounced trigger; it
  schedules `fireBroadcast` via `setTimeout(coalesceMs)` and
  no-ops while a coalesce window is open.
- `QueueShop.fireBroadcast` recomputes the snapshot, diffs against
  `lastBroadcastSnapshot`, and either skips (empty delta), sends a
  delta envelope, or sends a snapshot envelope (first broadcast
  with no prior snapshot cached).
- `QueueShop.sendProjectionTo` (= new-connect handshake) always
  sends a snapshot envelope, reusing `lastBroadcastSnapshot` when
  available.
- `apps/web/src/lib/api.ts` `connectQueueFeed` keeps a local
  `localShopState` mirror, branches on the envelope `kind`, and
  surfaces the merged snapshot through the existing
  `onProjection` callback. Consumers (landing / `/ticket` /
  `/staff`) are unchanged.
- New env `BROADCAST_COALESCE_MS` joins
  `apps/default/src/server/http/types.ts`.

## Context

ADR-0071 explicitly deferred this work. The cap-removal there
made `waitingPreview` a full Waiting list, which puts the
broadcast payload at:

| Waiting tickets | Per entry | Total payload |
|--|--|--|
| 100 | ~80 bytes | ~10 KB |
| 1000 | ~80 bytes | ~100 KB |

A 1000-ticket queue with 30 dispatches / minute and 1000 client
tabs sums to **~3 GB / minute outbound** from a single Cloudflare
Worker. The bandwidth cost of operating a busy single-shop tier
becomes an operational concern long before any deployment hits
the runtime CPU limit; the throttle / differential mechanism is
the cheapest fix that preserves the per-mutation push semantics.

User direction (2026-05-12 plan): "1000 名 scale 差分 broadcast
— ADR-0071 §Trade-offs で defer された問題を解消".

## Trade-offs

| | ADR-0071 (raw snapshot) | **This ADR (delta + coalesce)** |
|--|--|--|
| Wire bytes per dispatch | ~80 × N | ~80 × Δ (changed entries only) |
| Bandwidth at 1000 wait × 30 disp/min × 1000 tabs | ~3 GB/min | ~30 MB/min (typical Δ ≈ 10) |
| Client CPU per message | parse + replace | parse + merge (O(Δ)) |
| Server CPU per dispatch | full project + JSON.stringify | full project + diff + JSON.stringify |
| New connect cost | full snapshot | full snapshot (unchanged) |
| Coalesce latency | 0 | up to `BROADCAST_COALESCE_MS` (default 100 ms) |
| Backward compat | n/a (the wire is upgraded) | client falls back if `v !== 5` (forward-compat) |

The 100 ms coalesce window trades imperceptible UI latency
(humans don't notice <200 ms in queue dashboards) for a 5-10×
broadcast-frequency reduction during burst dispatches (e.g. a
staff member calling 5 customers in 2 seconds). Combined with
the per-broadcast 99% delta compression, the bandwidth budget
recovers ~95% in the 1000-ticket scenario.

## Consequences

- The DO holds one extra in-memory `ShopState` reference (the
  cached snapshot). On eviction the cache is lost; the next
  broadcast arrives without a baseline and falls back to a full
  snapshot envelope (the first dispatch after a cold-start is
  free of size benefit, subsequent dispatches resume delta).
- Clients that connect mid-broadcast (= during the 100 ms
  coalesce window) get the snapshot from `sendProjectionTo`
  using `lastBroadcastSnapshot`, then the delta when the timer
  fires — coherent because the delta is computed against the
  same snapshot the client received on connect.
- The `delta-before-snapshot` race (= server somehow emits a
  delta before the client received its initial snapshot) is
  handled by closing the socket with code 1011; the client's
  reconnect logic re-handshakes via `sendProjectionTo` and
  receives a fresh snapshot. The path is defensive — under
  normal operation it's unreachable because every WS upgrade
  triggers `sendProjectionTo` before any subsequent dispatch.
- The `pendingNoShow[]` array (ADR-0074) is added to the
  envelope alongside `calling[]` / `serving[]` /
  `waitingPreview[]`; the diff helper handles all four
  uniformly.
- The wire envelope version bump is **forward-compatible only**:
  a v4-only client sees an unrecognised `{v: 5, kind, …}` payload
  and the existing fall-through arm in `connectQueueFeed`
  delegates to the consumer unchanged. A future v6 follows the
  same pattern.

## Alternatives considered

- **Coalesce only, no delta.** Rejected — the per-broadcast
  payload size is the dominant cost. Coalescing 5 dispatches
  into 1 broadcast saves 80% of *count* but only 20% of *bytes*
  in a 1000-ticket scenario.
- **Delta only, no coalesce.** Rejected — the 100 ms coalesce
  is what allows the diff to be meaningful. Without it a 5-call
  burst fires 5 broadcasts where the diff between consecutive
  snapshots is ~1 entry each (good ratio per broadcast, but the
  count overhead remains).
- **Per-event broadcast (= push the TicketEvent itself, client
  applies via core's `applyEvent`).** Rejected for this ADR —
  the existing `applyEvent` is over the canonical Ticket type
  with PII, while the WS payload strips PII. A per-event broad-
  cast would need a parallel "PublicTicketEvent" type and a
  matching client-side projection. This ADR's per-array delta
  achieves the same bandwidth reduction without that schema
  duplication; it can be revisited if event-stream semantics
  become useful for other reasons.
- **Bigger coalesce window (200-500 ms).** Rejected as default —
  the staff Kanban "called" badge is the primary latency-
  sensitive surface, and a 500 ms window is at the edge of
  perceptibility. The env knob lets per-deployment tuning if
  needed.

## References

- ADR-0061 — original WS projection feed (the wire contract this
  ADR refines).
- ADR-0071 — Projection v4 + cap removal (the trade-off section
  that explicitly deferred this work).
- ADR-0074 — PendingNoShow grace period (the new
  `pendingNoShow[]` array that joins the diff).
