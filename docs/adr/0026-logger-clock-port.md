# 0026. Logger and Clock port wiring on Cloudflare Workers

- Status: accepted
- Date: 2026-05-05
- Deciders: Yasunobu
- Tags: ports, observability, infrastructure

## Context

ADR-0020 declared `Logger` and `Clock` as `Context.Tag` ports. Phase
0.5 ships their runtime-agnostic implementations in
`packages/core/src/infrastructure/{clock,logger}/`. Phase 1 will wire
them to Cloudflare Workers Logs and the Workers `Date` runtime.

This ADR captures the production wiring contract before it lands so
the API surface is stable across the Phase 0.5 → Phase 1 boundary.

## Decision

### Clock

- `SystemClockLive` (already shipped, Step 2) reads
  `Temporal.Now.instant()` directly. Cloudflare Workers expose a
  monotonic wall clock; no Cloudflare-specific shim is needed.
- A `MockClockLive` (Phase 1) will accept an `Instant` reference and
  expose `tick(duration: Temporal.Duration)` for time-travelling tests.

### Logger

- A `WorkersLoggerLive` Layer (Phase 1) maps
  `info` / `warn` / `error` to `console.{info,warn,error}` after
  serialising via `JSON.stringify(logPayload)`. Workers Logs ingests
  the JSON natively; the structured fields (`_tag`, `code`,
  `severity`, `traceId`, `data`, `cause`, `context`) are searchable.
- A `BatchLoggerLive` (Phase 1, optional) buffers payloads and flushes
  on `request.signal.aborted` for high-throughput endpoints.
- The PII guard (ADR-0009 + repo-level ripgrep gate) prevents customer
  PII from reaching `LogPayload.data` at the source level. The Logger
  port itself does **not** perform a runtime PII scrub — by ADR-0009,
  the source-level guard is the only enforcement point.

### Trace correlation

- Inbound HTTP requests assign a `TraceId` at the entry handler:
  `parseTraceId(request.headers.get("x-trace-id")) ??
  newTraceId()`. The id is passed into the per-request `Effect.Layer`
  composition so every `LogPayload` carries `traceId` automatically
  (via `withMeta` at the use-case boundary).

## Consequences

- The Phase 0.5 ports are stable. Phase 1 only needs to ship the
  Cloudflare-bound `Live` Layers; no port-shape changes.
- The `Logger` port returns `Effect.Effect<void>` rather than
  `void` so future implementations can fan out to multiple sinks
  (Workers Logs + a queue) without reworking call sites.

## References

- ADR-0009 (PII discipline).
- ADR-0020 (port Tags).
- `packages/core/src/application/ports/{Clock,Logger}.ts`,
  `packages/core/src/infrastructure/clock/SystemClockLive.ts`.
