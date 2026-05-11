# ADR-0088: Client obs ring + reporter + traceId

- Status: Accepted
- Date: 2026-05-11
- Stage: F / S20
- Refines: ADR-0087 (web shell)

## Decision

Add a client-side observability stack so the developer (and
the production on-call) can reconstruct exactly what the
browser saw, end-to-end, without source-level instrumentation
at every emit site. Four layers:

```text
apps/web/src/lib/obs/
├── events.ts        ← DevEvent discriminated union (FetchStart/End/Error,
│                     WsOpen/Frame/Close/Error, StoreMutation,
│                     UncaughtError, Lifecycle) — every variant carries
│                     `at: number` so a replay sorts after JSON round-trip
├── ringBuffer.ts    ← 256-entry circular buffer, mirrored to
│                     sessionStorage so a page reload preserves the last
│                     session's history
├── reporter.ts      ← severity-gated batched POST to
│                     /api/v1/__/client-error; 1s coalesce; PII sanitiser
│                     at the wire boundary
├── traceId.ts       ← Crockford-base32 26-char ULID generator (matches
│                     the server's ULID-shaped TraceId brand)
└── bus.ts           ← single emit hub: enriches event with severity,
                       pushes to ring, forwards reportable events to
                       reporter, broadcasts to in-process subscribers
```

### Why a ring + reporter pair, not just one

- **Ring** keeps full-fidelity history for the
  in-browser developer (clicks through `window.__obs.
  snapshot()` or the future `/dev/inspect` panel). No
  sanitisation here — the user sees their own session.
- **Reporter** is the escalation arm. Severity `warning` /
  `error` events forward to the server's audit-log sink
  (`/api/v1/__/client-error`, S22a / ADR-0090). The
  sanitiser strips `nameKana` / `phoneLast4` / `freeText`
  so the production POST never carries PII even if a
  future event variant accidentally embeds one.

The split exists because the two surfaces have different
trust assumptions: the ring is a session-local developer
tool, the reporter is a multi-tenant audit pipeline.

### Severity policy

The bus owns the default severity table:

```ts
const DEFAULT_BY_KIND: Record<DevEvent["kind"], Severity> = {
  FetchStart: "debug",
  FetchEnd: "debug",       // adjusted to "warning" when ok=false
  FetchError: "error",
  WsOpen: "info",
  WsFrameIn: "debug",
  WsClose: "info",         // adjusted to "warning" for code ≥ 4000
  WsError: "error",
  StoreMutation: "debug",
  UncaughtError: "error",
  Lifecycle: "info",
}
```

Per-emit overrides at the call site take precedence — if a
site has extra context (e.g. a `WsClose` with `code === 4429`
= rate-limit), it passes an explicit severity.

### Trace id generation

`generateTraceId()` produces a 26-character Crockford base32
ULID. The shape matches the server's `TraceId` brand (see
`@booking/core/traceIdFromHex`) so the same id can appear on
both sides of the wire. Trace ids surface in two places: per-
`fetch` request (set in `Authorization`-adjacent headers) and
per-event timestamp correlation in the ring.

### `window.__obs` global

Exposed dev + prod (user spec: "全 obs surface prod も
keep"). Read-only — `snapshot()` and `clear()` only; `emit`
is intentionally not exposed so an operator pasting code
into the console cannot pollute the ring with fake events.

## Consequences

- `apps/web/src/lib/api.ts:fetchJson`, `connectQueueFeed`,
  and `apps/web/src/lib/stores/shopState.svelte.ts:setShopState`
  become instrumented: each entry/exit/error emits the
  matching `DevEvent` through the bus.
- Production traffic now traces through the reporter for
  warning/error events. Reporter is opt-in fire-and-forget;
  a transient `POST /api/v1/__/client-error` failure logs
  to console without reentering the bus.
- The reporter's coalesce window (1s) bounds the egress
  to roughly one POST per error storm rather than one per
  event — safe under a flaky reconnect loop.
- `window.__obs` is the first instrumented surface a future
  operator can paste into the console for live triage.

## Status

- 2026-05-11 — Stack lands in commit `b7f94c8`. ADR
  drafted inline in commit message; ADR file followed in
  the obs sprint cleanup (2026-05-12).
