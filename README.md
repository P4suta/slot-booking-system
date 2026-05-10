# slot-booking-system

A walk-in queue for one in-person service business. The customer
takes a number; the shop sees the queue advance — that is the
entire shape of the product. One deployment serves one shop; the
core (`packages/core`) stays industry-agnostic so future
deployments (haircuts, repairs, consultations, …) can reuse it
unchanged.

## Iron principles (non-negotiable)

1. **Number-tag model** — no accounts, no logins, no email, no SMS,
   no notifications. The customer holds a `TicketId` plus the
   `(nameKana, phoneLast4)` handle they typed in.
2. **Minimum PII** — kana name, phone last 4, optional free text.
   Never email, full phone, address, birthday, gender, IP, UA, or
   persistent cookies (ADR-0054).
3. **Zero external dependencies** beyond Cloudflare. No mail / SMS /
   auth / payment / monitoring SaaS.
4. **Architecturally impossible double-call** — concurrency runs
   through the single-writer `QueueShop` Durable Object actor
   (ADR-0053), not code-level locks.
5. **Customer self-service** — every customer action lives behind
   handle verification. Staff never types a customer's data.
6. **Beauty over expedience** — the domain is the composition of
   three classical structures (event-sourced log + type-state
   machine + single-writer actor; ADR-0050). New code reuses the
   existing vocabulary or proposes an ADR.
7. **Operations as a feature** — observability (OTel), audit log
   retention, PII purge cron, staff capability gating, and the
   error-codes registry are first-class members of the contract.

## Stack (2026 wave)

- **Effect 4** (beta) — runtime, Schema, Layer, Tracer
- **drizzle-orm 1.0-rc** — D1 + DurableObject SQLite schema, codecs
- **Cloudflare Workers + Durable Objects + D1** — the deployment
- **SvelteKit 2** + Cloudflare Pages — the customer + staff UI
- **REST + SSE** for the queue surface; live projection push moves
  to **DO Hibernating WebSocket** (ADR-0057, on the queue-pivot
  follow-up plan)
- **paraglide-js 2** — i18n with identifier-safe message keys

## Architecture overview

Functional Core / Imperative Shell (ADR-0018):

```text
+----------------+      +----------------------+      +-------------------+      +---------------+
|   domain       | <--- |   application        | <--- |   infrastructure  | <--- |  apps/<name>  |
|   (pure)       |      |   (Effect, ports)    |      |   (Layers)        |      |  (CF Workers, |
|   ADTs +       |      |   use-cases return   |      |   typeid, Temporal,|      |   SvelteKit)  |
|   Schemas      |      |   Effect<…, R>       |      |   D1 / DO bindings |      |               |
+----------------+      +----------------------+      +-------------------+      +---------------+
```

- **domain** (`packages/core/src/domain/**`) — pure ADTs and
  combinators. The queue aggregate (`Ticket`) is a type-state
  discriminated union, transitions are total functions, and
  projections are monoid homomorphisms over the event log
  (ADR-0050 / ADR-0052).
- **application** (`packages/core/src/application/**`) — `Effect`
  use cases (Issue / CallNext / Recall / MarkServed / MarkNoShow /
  Cancel) and `Context.Service` ports (Clock / IdGenerator /
  TicketRepository / Logger / AuditLogger / RuntimeMode /
  ErrorRedaction / LogSampler).
- **infrastructure** (`packages/core/src/infrastructure/**`) —
  runtime-agnostic Live layers (Temporal-backed Clock, ULID
  IdGenerator, in-memory event-sourced repo for tests).
  Cloudflare-bound adapters live under `apps/<name>/src/server/`.
- **presentation** — two apps:
  - `apps/default` (Cloudflare Worker) — REST + SSE surface
    (`/api/v1/...`) + the `QueueShop` Durable Object actor. The
    only place that calls `Effect.runPromise`. Wraps the worker
    handler in `@microlabs/otel-cf-workers` `instrument(...)` so
    every request is a W3C Trace-Context root span.
  - `apps/web` (Cloudflare Pages, SvelteKit 2) — customer +
    staff routes (`/`, `/issue`, `/ticket`, `/staff`). Speaks
    REST via a typed client (`apps/web/src/lib/api.ts`); SSE
    keeps the live projection in sync.

The pure-domain layer carries 300+ tests with C1-100 % branch
coverage (vitest V8 + threshold), property-based fast-check tests
on the type-state transitions and monoid homomorphism, and the
`docs/error-codes.md` drift gate that rebuilds the registry from
`Errors.ts` on every push.

Architectural invariants are enforced by `dependency-cruiser`
(`.dependency-cruiser.cjs`) and the `comment-bans` ripgrep gate in
`lefthook.yml`.

## Development

All toolchain runs inside the Docker dev container (ADR-0015). The
host needs only `just`, `lefthook`, `committed`, `typos`,
`actionlint`, and `markdownlint-cli2` (managed by `mise`).

| Recipe | Purpose |
|---|---|
| `just bootstrap` | Build the dev image + install deps + register lefthook |
| `just check` | Full pre-push gate (lint + typecheck + arch + vitest + coverage + knip + drift) |
| `just dev-up` | OTel collector + Jaeger UI + `wrangler dev` (apps/default) |
| `just dev-default` | `wrangler dev` only (no observability stack) |
| `just dev-web` | Vite for `apps/web` |
| `just migrate-local` | Apply D1 migrations to the local fixture |
| `just trigger-scheduled` | Fire the daily PII-purge handler against `wrangler dev` |
| `just gen-error-docs` | Regenerate `docs/error-codes.md` from `errorClassRegistry` |
| `just bench` | Vitest bench baselines |
| `just mutation` | Stryker mutation testing (heavy; on demand) |
| `just log-tail` | Tail `wrangler dev` JSON logs through `jq` for trace correlation |

Per-recipe details live in [`Justfile`](./Justfile). Operator
playbook for incident triage:
[`docs/operator/runbook.md`](./docs/operator/runbook.md).
Observability primer:
[`docs/observability.md`](./docs/observability.md). Dev workflow
walkthrough: [`docs/dev-workflow.md`](./docs/dev-workflow.md).

## Production secrets

`STAFF_SESSION_SECRET` is provisioned via `wrangler secret put`; the
local-dev value lives in `apps/default/.dev.vars` (gitignored). The
example template is `apps/default/.dev.vars.example`.

## Door-QR walk-in entry (ADR-0068)

The deployment has no in-store kiosk; walk-in customers reach the
queue via their own phone after scanning a QR code at the shop
entrance. The QR encodes the canonical `/issue` URL — for the
default deployment that is `https://<your-host>/issue`. Print it
as a 2-D barcode with any generator, post it at the door, and
the rest of the flow (walk-in 「番号札を取る」 ✕ reservation
expand) lives in the same page. No env var, no code change.

## License

Dual-licensed under Apache-2.0 OR MIT, at your option. See
[LICENSE-APACHE](./LICENSE-APACHE) and [LICENSE-MIT](./LICENSE-MIT).

By contributing you agree that your contribution is dual-licensed
under the same terms — see [CONTRIBUTING.md](./CONTRIBUTING.md).
