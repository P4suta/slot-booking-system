# 0038. OpenTelemetry semconv unification of Trace · Audit · Log

- Status: accepted
- Date: 2026-05-07
- Deciders: Yasunobu
- Tags: observability, opentelemetry, telemetry, w3c-trace-context

## Context

Phase 0.12 wired three independent observability sinks:
`WorkersLoggerLive` (JSON to `console.*`), `D1AuditLoggerLive`
(persistent `audit_log` rows), and the `CurrentTraceId` FiberRef
(in-memory request correlation). Operators could correlate by
trace id manually but had no unified surface for distributed
tracing — Cloudflare native traces existed but did not record
domain-level error semantics.

Phase 2.6 / BI-9 set out to **unify** the three on OpenTelemetry
semantic conventions, so a single trace dashboard shows logs +
audits + spans for any given request, with every `DomainError`
labeled by `error.type` / `error.code` / `error.severity` automatically.

## Decision

### SDK choice — `@microlabs/otel-cf-workers`

The Cloudflare-Workers OTel adapter (`@microlabs/otel-cf-workers@1.0.0-rc.52`)
is the de-facto path. Pros vs. bare `@opentelemetry/api` + native
Cloudflare tracing:

| | otel-cf-workers | bare API + native CF tracing |
|---|---|---|
| W3C inbound/outbound | automatic | manual parser + injector (~40 LoC) |
| DO fetch instrumentation | automatic | manual span around every `stub.fetch` |
| Exporter choice (Honeycomb / Jaeger / OTLP) | yes | dashboard only |
| Dependency | 1 (rc, production-used, last release 2025-05) | 0 |
| Effect bridge | works via `Effect.currentSpan` reading active span | works (same path) |

The "rc" status of `@microlabs/otel-cf-workers` is real but the
package has been at `1.0.0-rc.52` for 18+ months, used by Honeycomb /
Tracetest / Axiom guides, and the maintainer explicitly stays at rc
until the OTel JS spec settles. CLAUDE.md §3 "2026 mainstream"
applies — this is the standard path.

### Layered architecture

```text
┌─────────────────────────────────────────────────────────────┐
│ apps/default/src/worker.ts  default export                  │
│   ↓ wrapped by                                              │
│ instrument(handler, otelConfig)  ← @microlabs/otel-cf-workers│
│   • W3C inbound traceparent → active span                   │
│   • W3C outbound on fetch  ← auto-injection                 │
│   • root span per request / scheduled invocation            │
│   • exporter: OTEL_EXPORTER_URL or local OTLP fallback      │
└─────────────────────────────────────────────────────────────┘
                          ↓ provides
┌─────────────────────────────────────────────────────────────┐
│ packages/core/src/application/runtime/Telemetry.ts          │
│   withSpan(name, attrs, eff)                                │
│   addAttributes(attrs)                                      │
│   recordTaggedError(e)  ← derivation over errorClassRegistry│
│   tapTaggedError(eff)                                       │
└─────────────────────────────────────────────────────────────┘
                          ↓ consumed by
┌─────────────────────────────────────────────────────────────┐
│ apps/default/src/server/adapters/                           │
│   WorkersLoggerLive — emits log.<level> span event +        │
│                       JSON console line                     │
│   D1AuditLoggerLive — withSpan("audit_write", attrs) +      │
│                       Logger delegation on failure          │
│ apps/default/src/server/graphql/yoga.ts                     │
│   useDomainErrorTrace plugin — lifts Pothos errors plugin   │
│                       extensions onto active span as        │
│                       error.* attrs + recordException       │
└─────────────────────────────────────────────────────────────┘
```

`packages/core` does **not** import `@opentelemetry/api`. It uses
`Effect.currentSpan` / `Effect.withSpan` / `Effect.annotateCurrentSpan`,
which the Cloudflare entry feeds via `instrument(...)`'s tracer
provider. The `dep-cruiser` direction (apps depend on core, not
inverse) is preserved.

### `recordTaggedError` derivation

The OTel `error.*` semconv attributes are projected from each
`DomainError`'s static `code` / `severity` (Phase 2.0 / BI-2
`errorClassRegistry`). Adding a new error class to the registry
populates the OTel attributes for free — **one taxonomy, three
projections**: `errorToGraphQLPayload` (Pothos), `toLogPayload`
(Workers Logs), `recordTaggedError` (OTel spans).

The 33-class registry coverage is property-tested
(`packages/core/test/property/recordTaggedError.test.ts`).

### Internal vs. external trace IDs

The legacy `CurrentTraceId` FiberRef (Phase 0.12) carries a
ULID-shaped `TraceId` brand for internal cross-log correlation.
OTel's `Tracer.Span` exposes a 32-char hex traceId from the W3C
header (or a fresh OTel-format minted by `instrument(...)`).

The two formats coexist deliberately:

- `audit_log.traceId` — ULID, internal correlation. Unchanged
  from Phase 0.12.
- OTel span attributes / events — hex, distributed-tracing
  correlation. New in Phase 2.6.

Operators reconcile via the runbook procedure
(`docs/operator/runbook.md` § "Tracing a single request
end-to-end"): the response `traceId` (ULID) appears alongside the
OTel `trace_id` in Workers Logs; the dashboard cross-link uses both.

Unifying the brand (e.g. `mintTraceId()` returning OTel hex
directly) was considered but rejected:

- ULID's lexicographic time-ordering is what the audit table's
  read-by-time pattern relies on.
- Migrating the brand would touch ~12 sites that consume `TraceId`
  with the implicit ULID format assumption.
- The operator-facing concept is unchanged: one id per request,
  searchable in both surfaces.

`getCurrentTraceId` therefore reads from the active OTel span and
re-encodes its 32-hex traceId as a Crockford ULID via
`traceIdFromHex` — same 128 bits, two display encodings — and the
operator runbook documents the pivot procedure between OTel-native
trace search and audit-log queries. The FiberRef carrier
(`CurrentTraceId`) and the now-unused `withTraceId` / `mintTraceId`
helpers were dropped as part of this resolution (see commit `9ad912f`,
`refactor(core): TraceContext on currentSpan`); the ULID `TraceId`
brand stays as the audit surface concept.

## Consequences

### Positive

- W3C Trace Context propagation is automatic (no `traceparent`
  parser code in our codebase).
- Every `DomainError` is auto-decorated with OTel semconv attrs —
  no manual catalogue sync.
- Audit-write failures emit both a span exception event AND the
  existing Logger delegation (commit `8e71422`) — operators see
  the failure in three surfaces simultaneously.
- The exporter is configurable via `OTEL_EXPORTER_URL` env var,
  so deployments can point at Honeycomb / Jaeger / Axiom without
  code changes. Local dev falls back to `http://localhost:4318/v1/traces`.

### Negative

- Two trace IDs (ULID + OTel hex) per request. Mitigation: the
  runbook documents the cross-link procedure.
- `@microlabs/otel-cf-workers` rc status — non-blocking but the
  pin should be reviewed when the package reaches stable.
- Bundle size: ~40 KB added to the worker (mostly OTel SDK). The
  core package's size-limit is unaffected; the apps/default
  budget has headroom (currently 166.92 KB / 200 KB).

### Carry-over

- **TraceContext FiberRef → Span integration**: ✅ resolved in
  commit `9ad912f` (`refactor(core): TraceContext on currentSpan`).
  `getCurrentTraceId` now reads from `Effect.currentSpan` and
  re-encodes the OTel hex traceId to Crockford ULID via
  `traceIdFromHex` on `TraceId`; the `CurrentTraceId` FiberRef +
  `withTraceId` / `mintTraceId` helpers (never seeded in production)
  are gone.
- **e2e test for span emission**: `BasicTracerProvider` +
  `InMemorySpanExporter` in test setup, asserting each
  `BookingError` path produces the expected `error.type`
  attribute. Deferred with the broader Miniflare integration
  suite (ADR-0036 carry-over registry).
- **Crash recovery test**: `@cloudflare/vitest-pool-workers`
  smoke for OTel context propagation across DO restarts. Same
  carry-over batch.

### Phase 3 PR#8 retrospective (2026-05-08)

The original Phase 2.6 / BI-9 scope unified `error.*` semantic
conventions on use-case-bound spans. Phase 3 PR#8 / commit 12
extends the projection to the remaining two surfaces the trace
tree crosses: the **D1 audit-write** and the **Cloudflare Durable
Object RPC dispatch** hops.

| Surface | Span name | New semconv keys |
|---|---|---|
| D1 audit insert | `audit_write` | `db.system.name="d1"` / `db.operation.name="INSERT"` / `db.collection.name="audit_log"` / `db.query.text` (template, PII-free) |
| DO RPC dispatch | `messaging.cloudflare.do.dispatch` | `messaging.system="cloudflare.do"` / `messaging.operation.type="send"` / `messaging.destination.name=DaySchedule:<day>` / `rpc.system="effect.unstable.rpc"` / `rpc.method=<envelope.tag>` |
| Use cases | `usecase.<Verb>` | `usecase.invocation.kind` ∈ `{"graphql","scheduled"}`, plus `graphql.operation.{type,name}` for the four customer mutations |

The existing application-private keys (`usecase.input.*` /
`audit.*`) survive untouched — semconv supplements rather than
replaces them, so dashboards keyed off either namespace continue to
work and ad-hoc domain queries (e.g. "audits for actor X") need no
rewrite. ADR-0044 (DO RPC envelope sanitiser) is the adjacent piece
of the same trace-tree: the sanitiser fixes the cross-realm
structured-clone failure that was previously masking the dispatch
hop's existence in operator dashboards.

The OTel database semantic-convention version pinned here is the
stable 1.27 surface (`db.system.name`, not the legacy `db.system`).
The messaging convention is the post-1.27 stable surface
(`messaging.operation.type` rather than the legacy `messaging.operation`).

Test plan:

- `apps/default/test/usecase/Telemetry.semconv.test.ts` — pin the
  use-case attribute table (literal-key assertion per use case via a
  recording `Tracer.Tracer`; lives in `apps/default` because the OTel
  SDK is an apps-tier dep, the use cases under test ride the
  `@booking/core` package surface).
- `apps/default/test/effectRpc/transport.test.ts` —
  `messagingAttributesFor` projection table.
- `just dev-up` Jaeger UI shows the four-layer
  `graphql.<Verb>` → `messaging.cloudflare.do.dispatch` →
  `usecase.<Verb>` → `audit_write` tree on every booking mutation
  (the integration `holdSlot.integration.test.ts` round-trips the
  full chain under Miniflare).

## References

- Plan: `~/.claude/plans/cosmic-conjuring-milner.md` Phase 2.6.
- Plan execution: `~/.claude/plans/bi-4-fluttering-codd.md` Phase C.
- Phase 0.12 commits seeded the trace · audit · log triple.
- Commit `8e71422` "refactor(default): Audit failure → Logger
  (2.6 BI-9)" carried the C4 silent-swallow fix that this ADR
  builds on.
- ADR-0009 (PII retention) — the audit-log surface stays PII-free
  by construction; OTel attribute names follow the semconv
  `error.*` namespace, no payload fields are leaked.
