# ADR-0091: DevLogStream DO + `/api/v1/__/dev/log-stream`

- Status: Accepted
- Date: 2026-05-12
- Stage: F / S22 cont.
- Refines: ADR-0083 (DO hub-spoke split), ADR-0090 (client
  error endpoint)

## Decision

Add a second Durable Object — `DevLogStream` — that relays
every structured-log line the worker emits to any client
subscribed over WebSocket at `/api/v1/__/dev/log-stream`.
Gated on `IS_DEV === "1"`; production deploys see a 404, and
the binding stays sleeping with zero traffic.

```text
worker.ts:fetch
  └── if (isDevMode(env)) __setDevLogPublisher(stub.publishLog)
       │
       ▼ via devLogTap.ts:emitStructuredLog seam
  WorkersLoggerLive ──┐
  clientReport.ts ────┼──► console.{info,warn,error}  (always)
  errorEnvelope.ts ───┤   + publishDevLog (only in dev)
  requestLog.ts ──────┘
                          └──► DevLogStream.publishLog (RPC)
                                  └──► ring buffer + WS broadcast
```

### Why a separate DO

`ADR-0083` splits the QueueShop actor into hub + spokes
specifically to bound its blast radius. Folding a dev-only
fan-out into the queue actor would mix audiences (the WS
relay's lifecycle has zero overlap with the queue's
hibernation contract + alarm scheduling). One additional
binding + one migration row is a reversible cost — the DO
class sleeps when `IS_DEV=0`, costing nothing in prod.

```toml
# wrangler.toml
[[durable_objects.bindings]]
name = "DEV_LOG_STREAM"
class_name = "DevLogStream"

[[migrations]]
tag = "v3"
new_sqlite_classes = ["DevLogStream"]
```

### Why in-memory only (no SQLite)

The log stream is best-effort live observability, not an
audit log. A hibernation wake legitimately starts with an
empty ring — the operator sees the next entries the moment
they flow, not a backfilled history from cold storage.

The size-256 ring is sized against the worker's typical
emit rate (one HttpRequest + one HttpEnvelope per failing
request + ad-hoc ClientReport entries): it keeps ~5 minutes
of moderate-traffic history for a freshly-reconnecting
`/dev/inspect` session.

### Publisher seam

The `__setDevLogPublisher` module-level setter mirrors the
existing `__setRequestLogTap` / `__setEnvelopeLogTap`
pattern. Every emit site calls a single helper:

```ts
export const emitStructuredLog = (
  level: "info" | "warn" | "error",
  line: string,
): void => {
  if (level === "info") console.info(line)
  else if (level === "warn") console.warn(line)
  else console.error(line)
  publishDevLog({ level, emittedAt: Date.now(), line })
}
```

Production keeps `publisher` null (no-op); dev binds it to
the DO stub. The seam adds one null-check to the hot path
regardless of mode.

### Route gating

```ts
const route_devLogStream: RouteDescriptor = {
  method: "GET",
  path: "/api/v1/__/dev/log-stream",
  handle: (c) => {
    if (!isDevMode(c.env)) return new Response("Not Found", { status: 404 })
    if (c.req.header("upgrade") !== "websocket") return c.text("…", 426)
    const obj = c.env.DEV_LOG_STREAM.get(env.DEV_LOG_STREAM.idFromName("main"))
    return obj.fetch(c.req.raw)
  },
}
```

The 404 in prod is intentional — the surface is undiscoverable
to a production hit, no error envelope leakage, no upgrade
response that would hint at a hidden capability.

## Consequences

- Every structured-log line the worker emits is observable
  in real time inside `/dev/inspect` (S23 / ADR-0092).
- Production traffic is unaffected — `console.{info,warn,
  error}` continues to feed Workers Logs, the DO stays
  asleep.
- The `migrations v3` row is permanent; rolling back the
  binding requires a follow-up migration. Reversible but
  not trivial.
- Single instance per shop (`idFromName("main")`) — there
  is no sharding requirement for a dev observability
  channel.

## Status

- 2026-05-12 — DO + endpoint + emit seam land in commit
  `94a6f14`. The `/dev/inspect` consumer follows in
  S23 / ADR-0092.
