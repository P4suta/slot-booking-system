# Observability

How to read what the running queue is doing. The observability stack
is one taxonomy projected onto three surfaces (ADR-0017 / ADR-0038):
the JSON API envelope, the structured access log, and the
OpenTelemetry trace tree. Every domain failure carries the same
`tag` / `code` / `severity` / `i18nKey` quartet across all three.

## Stack at a glance

```text
┌─────────────────────────────────────────────────────────────────┐
│ apps/default worker                                             │
│                                                                 │
│   instrument(handler, otelConfig)  ← @microlabs/otel-cf-workers │
│     │                                                           │
│     │ W3C trace context (inbound + outbound auto-propagation)   │
│     ▼                                                           │
│   ┌───────────────────────────────────────────────────────────┐ │
│   │ Hono router (apps/default/src/server/http/router.ts)      │ │
│   │   Effect-Schema validation → DO dispatch                  │ │
│   └────────┬──────────────────────────────────────────────────┘ │
│            │                                                    │
│   ┌────────▼─────────────────────────────────────────────────┐  │
│   │ packages/core runtime/Telemetry.ts                       │  │
│   │   withSpan(name, semconv-attributes, body)               │  │
│   │   recordTaggedError(e)  → error.* projection             │  │
│   └────────┬─────────────────────────────────────────────────┘  │
│            │                                                    │
│   ┌────────▼─────────────┐  ┌──────────────────────────────┐    │
│   │ WorkersLoggerLive    │  │ OTel span exporter           │    │
│   │   JSON to console.*  │  │   OTLP → otel-collector      │    │
│   │   sampled by         │  │   collector → Jaeger UI      │    │
│   │   LogSamplerLive     │  │   (`just dev-up`)            │    │
│   │   (severity-keyed)   │  │                              │    │
│   └──────────────────────┘  └──────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

A request's life on the trace tree:

```text
worker root span                                  (instrument, W3C inbound)
└── http.<METHOD> /api/v1/<path>                  (Hono — http.* attributes)
    └── messaging.cloudflare.do.dispatch          (DO RPC client — messaging.*)
        └── usecase.<Verb>                        (use case — usecase.invocation.*)
            ├── repo.save / repo.issue            (event log + projection write)
            └── audit_write                       (D1 audit insert — db.*)
```

## OpenTelemetry semconv attribute table

| Span | semconv namespace | Key attributes |
|---|---|---|
| `http.<METHOD> /api/v1/<path>` | OTel HTTP server | `http.request.method`, `http.route`, `http.response.status_code` |
| `messaging.cloudflare.do.dispatch` | OTel Messaging | `messaging.system="cloudflare.do"`, `messaging.operation.type="send"`, `messaging.destination.name="QueueShop:<shopId>"` |
| `usecase.<Verb>` | application semconv | `usecase.invocation.kind` ∈ `{"http","scheduled"}`, plus `usecase.input.*` (PII-free domain identifiers only — `ticket.id`, `seq`, `actor`) |
| `repo.save` / `repo.issue` | OTel DB 1.27 | `db.system.name="cloudflare-do-sqlite"`, `db.operation.name="INSERT"`, `db.collection.name` ∈ `{"ticket_events","aggregate_snapshots","tickets","outbox"}` |
| `audit_write` | OTel DB 1.27 | `db.system.name="d1"`, `db.collection.name="audit_log"`, `db.query.text=<template>` |
| any span carrying a domain error | OTel error semconv | `error.type=<Tag>`, `error.code=<E_…>`, `error.severity` |

ADR-0038 is the formal write-up.

## RuntimeMode dispatch (ADR-0042)

Two-valued tag (`"dev"` / `"prod"`) injected at the worker boundary,
selecting verbose vs. terse adapters via `Layer.unwrap`:

| Adapter | Dev arm | Prod arm |
|---|---|---|
| `ErrorRedactionLive` (ADR-0043) | `devRedactCause` — exposes `{name, message, stack[0..3], originalTag?}` on the API envelope's `extensions.cause` field | `prodRedactCause` — empty object (terminal redactor); cause never crosses the wire |
| `LogSamplerLive` | `passThroughSampler` — emits every line | severity-keyed rates `validation: 0.1`, `domain: 0.5`, `infrastructure: 1.0` (curried via `makeLogSamplerLive(rates)` so deployment env can override) |
| OTel span exporter | `ConsoleSpanExporter` (or OTLP collector if `OTEL_EXPORTER_URL` is set) | OTLP only, panic if collector unreachable |

The mode is bound once at the `apps/<deployment>` layer through
`makeRuntimeModeLayer(env)` so each deployment's wrangler env decides
the boolean once. Core stays runtime-agnostic.

## The dev workflow

```sh
# Bring up the OTel collector + Jaeger + wrangler dev (apps/default):
just dev-up
# Visit:
#   http://localhost:8787/api/v1/queue   (the public projection)
#   http://localhost:16686               (Jaeger UI — search for `usecase.IssueTicket`)

# Tail logs through jq, filtering on a single trace ID:
just log-tail | jq 'select(.traceId == "01H...XYZ")'

# Smoke a queue flow end-to-end:
just smoke-queue
# The IssueTicket → CallNext → MarkServed sequence produces a
# http.POST → messaging.cloudflare.do.dispatch → usecase.* →
# repo.save four-layer span tree visible in Jaeger.

# Trigger the PII-purge cron (single shot):
just trigger-scheduled
# Produces a usecase.PurgeStalePii span with
# usecase.invocation.kind="scheduled".
```

## Cross-correlation (audit log ↔ trace ↔ user-facing error)

Every request carries a single `traceId` ULID plus the OTel-native
32-hex traceparent. The relation between the two is:

```text
ULID  ⇄  traceIdFromHex(otel.traceparent.trace_id)
```

Operators reconcile via the runbook procedure
([docs/operator/runbook.md](./operator/runbook.md) §"Trace a single
request"):

1. The customer reports an error code (e.g. `E_INF_STORAGE`).
2. Find the matching access-log line — `code` is searchable.
3. Read the line's `traceId` (ULID).
4. Convert to hex via `traceIdFromHex` (or `audit_log.trace_id` SQL
   row → join on hex).
5. Open the Jaeger UI at the OTel trace → find the
   `usecase.<Verb>` span → expand its child `repo.save` / `audit_write`
   for the storage state.

The same `traceId` appears on the API envelope's `extensions.traceId`
field (dev mode only, ADR-0043) so users can paste it back to ops.

## Sampling caveat (`LogSamplerLive`)

The prod sampler is `Math.random()`-based, fresh per call. A burst
of `validation` errors at 0.1 rate produces a Bernoulli-distributed
log volume, not a strict 1-in-10 quota. For deterministic sampling
under regression analysis, swap to a counter-based sampler at the
adapter; the port (`LogSampler`) stays unchanged. ADR-0042 covers
the env-indexed dispatch shape; the curried factory
`makeLogSamplerLive(rates)` lets a worker entrypoint feed env-derived
rates without a code change.

## What lives where

- `packages/core/src/application/runtime/Telemetry.ts` — the
  `withSpan` / `addAttributes` / `recordTaggedError` /
  `tapTaggedError` helpers. Effect-tracer-flavoured; no
  `@opentelemetry/api` import in core.
- `apps/default/src/worker.ts` — the `instrument(...)` wrap, OTel
  exporter wiring.
- `apps/default/src/server/http/router.ts` — the Hono router; each
  route runs inside a Hono-instrumented HTTP span.
- `apps/default/src/server/adapters/WorkersLoggerLive.ts` —
  `console.{info,warn,error}` JSON sink, decorated with the active
  span's traceId.
- `apps/default/src/server/adapters/D1AuditLoggerLive.ts` — the
  `audit_write` span, `db.*` attributes.
- `apps/default/src/server/adapters/DurableObjectTicketRepositoryLive.ts` —
  the `repo.save` / `repo.issue` spans around event-log + snapshot +
  projection writes.
- `packages/core/src/infrastructure/observability/` — the env-
  indexed adapter Live layers (`ErrorRedactionLive`,
  `LogSamplerLive`).
