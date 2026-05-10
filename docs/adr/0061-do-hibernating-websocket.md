# ADR-0061: DO Hibernating WebSocket projection feed

- Status: Accepted
- Date: 2026-05-09
- Refines: ADR-0050 (queue pivot), ADR-0053 (single-writer DO)

## Decision

The customer-facing live projection feed is a **DO Hibernating
WebSocket** at `/api/v1/queue/feed`. The Hono router forwards
`Upgrade: websocket` requests to the QueueShop DurableObject
unchanged; the DO accepts the server side via
`ctx.acceptWebSocket(server)` so the actor can hibernate (be
evicted from memory) between events without dropping the
connection. A per-mutation broadcast loop fans the anonymous
projection to every attached socket from inside `dispatch`.

The previous SSE polling endpoint (`/api/v1/queue/events`,
2 s `setInterval` + 30 s server-side close + client auto-reconnect)
is removed. The full mutation → broadcast latency is now bounded
by the DO event-loop tick rather than the polling interval.

## Context

The queue is a small but high-frequency-update domain: ticket
issue + the staff lifecycle each emit a state change every few
seconds during a busy period. The pre-pivot SSE design re-fetched
the full projection every 2 s regardless of whether anything had
changed, which:

- Wasted both client + DO read bandwidth on quiet windows.
- Added up to 2 s of perceived latency between staff calling
  the next ticket and the customer landing page reflecting it.
- Required a 30 s client-side reconnect dance to fit Workers'
  streaming budget.

Three options were on the table:

1. Keep the SSE poll + tighten the interval. Reduces latency but
   amplifies the read amplification.
2. Server-Sent Events with `controller.enqueue` triggered from
   the DO. SSE works at the worker boundary but Workers does not
   give a clean way to keep the per-customer `controller`
   reachable from the DO mutation path — every connection lives
   in its own isolate.
3. **DO Hibernating WebSocket**. The runtime owns the connection
   set; `ctx.getWebSockets()` yields every attached socket from
   *inside* the DO, and `ctx.acceptWebSocket(server)` makes the
   socket survive DO eviction. This is the platform-recommended
   pattern (Cloudflare docs: "WebSocket Hibernation API").

## Trade-offs

| | SSE poll | SSE push | **DO WS** |
|--|--|--|--|
| Push latency | O(2 s) | O(round-trip) | O(round-trip) |
| Read amplification | every 2 s | event only | event only |
| Survives DO eviction | yes (stateless) | no | yes |
| Server-side connection set reachable from mutation site | n/a | no | yes |
| Worker bundle cost | 0 | minor | 0 (runtime) |

Hibernating WS wins on every axis except the migration cost
(replacing the EventSource client + the SSE handler), which
amortises across the lifetime of the queue surface.

## Consequences

- `apps/web` swaps every `EventSource` + `queueEventSource` call
  site for `WebSocket` + `queueWebSocket`. Reconnection is the
  caller's responsibility — the WebSocket close code surfaces
  the cause, and a non-1000 close paints the reconnect banner.
- `QueueShop` gains four new methods: `fetch` (the upgrade
  entry), `webSocketMessage` (no-op, the feed is unidirectional
  today), `webSocketClose`, `webSocketError`. The DO's
  `dispatch` epilogue calls `broadcastProjection` after every
  successful state change.
- The broadcast carries the **anonymous** projection only
  (`waitingCount` + `serving.{id, seq}` + `waitingPreview` of
  `{id, seq}` pairs). Staff PII never reaches the WS feed —
  the staff dashboard re-fetches `/api/v1/queue` with the
  capability token after every push to render the PII view.
- The DO's class still uses the same `tag = "v2"` migration; the
  Hibernating WebSocket runtime sits on top of any DO without
  schema migrations because it does not change persistent state.
- `apps/default/src/server/http/openapi.ts` advertises
  `/queue/feed` (101 + 426 responses) instead of the old
  `/queue/events` text/event-stream entry.

Superseded-By:

## Refined-By

ADR-0071 (Projection v4 — state on every entry, cap removed).
The "anonymous projection only" decision in this ADR carried
forward to ADR-0071 as PII-only-not-public (kana, last4, freeText
remain staff-only). The state field — public information already
visible on the in-store monitor — moves onto the wire so /ticket
can resolve its own transitions from the WS feed alone, without
the per-broadcast `ticketByHandle` HTTP follow-up that was
consuming customer RL_VERIFY budget under v3.
