# slot-booking-system

Industry-agnostic time-slot booking core (`packages/core`) plus a
GraphQL Cloudflare Workers backend (`apps/default`) and a SvelteKit
2 + Cloudflare Pages frontend (`apps/web`). Phase 0–3 builds a complete
local-development reference: catalog management, slot search, customer
hold / confirm / cancel, HMAC-signed slot tokens, OpenTelemetry-semconv-
unified observability (trace + audit + log on the same trace ID), DO ↔
D1 outbox-driven event sourcing, and a drift-gated `BookingError`
catalogue. Production deploy / CI/CD / scale tuning are intentionally
out of scope (the `0.x.y` track aims at a complete local-dev reference,
not a 1.0 production SaaS).

The runtime stack tracks the 2026 Effect / Drizzle / Cloudflare wave:

- **Effect 4** (beta line) — runtime, Schema, Layer, Tracer, RpcGroup
- **drizzle-orm 1.0-rc** — D1 + DurableObject SQLite schema, codecs
- **graphql-js 16** + **lexicographicSortSchema** + GraphQL Yoga — the
  schema is *derived* from `Effect.Schema` via `derive/graphql.ts`
  (ADR-0041); a byte-equal SDL invariant pins drift on every commit
- **@microlabs/otel-cf-workers 1.0-rc** + **OpenTelemetry semconv 1.27** —
  one taxonomy projected onto three surfaces (GraphQL response,
  structured logs, OTel spans) per ADR-0017 / ADR-0038
- **paraglide-js 2** — i18n with identifier-safe message keys, drift-
  gated against `errorClassRegistry`

## Architecture overview

The codebase follows a **Functional Core / Imperative Shell** layering
(ADR-0018). Each layer has a strict purity rule and an enforced
import direction:

```text
+----------------+      +----------------------+      +-------------------+      +---------------+
|   domain       | <--- |   application        | <--- |   infrastructure  | <--- |  apps/<name>  |
|   (pure)       |      |   (Effect, ports)    |      |   (Layers)        |      |  (CF Workers, |
|   ADTs +       |      |   use-cases return   |      |   typeid, Temporal,|      |   SvelteKit)  |
|   Schemas      |      |   Effect<…, R>       |      |   D1 / DO bindings |      |               |
+----------------+      +----------------------+      +-------------------+      +---------------+
       Schema, Either, Data       Effect.Tag, Schema       Layer.succeed/effect       Effect.runPromise (× 1)
```

- **domain** (`packages/core/src/domain/**`) — pure data and
  combinators. Value objects, entities, and aggregates are declared
  as `Effect.Schema` (ADR-0019). Errors are `Data.TaggedError` with
  static `code` / `severity` fields (ADR-0017). State transitions
  are total functions over a discriminated union (ADR-0013) and
  emit a `BookingEvent` (Step 15 will move this to event sourcing).
- **application** (`packages/core/src/application/**`) — `Effect`
  use cases and `Context.Tag` ports. Five ports today (`Clock`,
  `IdGenerator`, `BookingRepository`, `EventStore`, `Logger`)
  per ADR-0020. Boundary `Schema`s
  (`application/schemas/HoldSlotRequest.ts`, more in Phase 1) live
  here.
- **infrastructure** (`packages/core/src/infrastructure/**`) —
  `Layer`s that implement the ports. Runtime-agnostic adapters
  (Temporal-backed Clock, ULID-backed IdGenerator, deterministic
  test fakes) live in core; Cloudflare-bound adapters live in
  `apps/<name>/src/server/adapters/` (Phase 1).
- **presentation** — two apps:
  - `apps/default` (Cloudflare Worker): GraphQL Yoga + the
    `derive/graphql.ts` Schema-to-GraphQL functor +
    DurableObject `DaySchedule` over typed `effect/unstable/rpc`.
    The only place that calls `Effect.runPromise`. Wraps the worker
    handler in `@microlabs/otel-cf-workers` `instrument(...)` so
    every request is a W3C-Trace-Context root span.
  - `apps/web` (Cloudflare Pages, SvelteKit 2.x): customer +
    staff routes. Speaks the same GraphQL endpoint via a tiny
    typed-string client (`apps/web/src/lib/graphql/`).

Architectural invariants are enforced by `dependency-cruiser`
(`.dependency-cruiser.cjs`), the `domain-purity` and `pii-guard`
ripgrep gates in `lefthook.yml`, and the Stryker mutation-testing
workflow (`just mutation`).

The pure-domain layer carries:

- **370+ tests, C1 100 % branch coverage** (vitest V8 + threshold).
- **Property-based tests** (`fast-check`) including `fc.commands`-
  driven model-based tests for the booking state machine.
- **Type-level brand assertions** (`test/type/Brands.test.ts`)
  using `expect-type`.
- A reproducible **bench baseline**
  (`packages/core/test/slot/computeAvailableSlots.bench.ts`).

For the deployment-side wiring see ADR-0008 (apps vs core layout)
and ADR-0011 (core distribution shape).

## Development

All toolchain runs inside the Docker dev container (ADR-0015). The
host needs only `just`, `lefthook`, `committed`, `typos`,
`actionlint`, and `markdownlint-cli2` (managed by `mise`).

| Recipe | Purpose |
|---|---|
| `just bootstrap` | Build the dev image + install deps + register lefthook |
| `just check` | Full pre-push gate (lint + typecheck + arch + vitest + coverage + knip + size-limit + schema/error-doc drift) |
| `just dev-up` | Bring up the OTel collector + Jaeger + `wrangler dev` (apps/default) — the inner-loop dev stack |
| `just dev-default` | `wrangler dev` only (no observability stack) |
| `just migrate-local` | Apply D1 migrations to the local fixture |
| `just seed` | Populate the catalog with the demo entities |
| `just smoke-all` | `migrate-local` → `seed` → `availableSlots` smoke → `holdSlot` end-to-end |
| `just trigger-scheduled` | Fire the `PurgeStalePii` scheduled handler against `wrangler dev` |
| `just test-integration` | Miniflare in-process integration suite (DO crash recovery + `holdSlot` round-trip) |
| `just gen-error-docs` | Regenerate `docs/error-codes.md` from `errorClassRegistry` |
| `just bench` | `computeAvailableSlots` performance baseline |
| `just mutation` | Stryker mutation testing (heavy; on demand) |
| `just log-tail` | Tail `wrangler dev` JSON logs through `jq` for trace correlation |

Per-recipe details live in [`Justfile`](./Justfile). The full
GraphQL surface lives at [`docs/api/graphql.md`](./docs/api/graphql.md);
the operator playbook for incident triage lives at
[`docs/operator/runbook.md`](./docs/operator/runbook.md);
the observability primer is [`docs/observability.md`](./docs/observability.md);
the fresh-clone walkthrough is [`docs/dev-workflow.md`](./docs/dev-workflow.md).

## License

Dual-licensed under Apache-2.0 OR MIT, at your option. See
[LICENSE-APACHE](./LICENSE-APACHE) and [LICENSE-MIT](./LICENSE-MIT).

By contributing you agree that your contribution is dual-licensed under
the same terms — see [CONTRIBUTING.md](./CONTRIBUTING.md).
