# Developer workflow

Fresh-clone walkthrough — what to install, what to run, and what to
expect at each step. Every command runs inside the Docker dev
container (ADR-0015) except where explicitly marked **(host)**.

## Prerequisites

On the host:

- Docker (Docker Desktop on macOS / Windows, native Docker on Linux).
- `mise` — pins the host-side toolchain (`just`, `lefthook`,
  `committed`, `typos`, `actionlint`, `markdownlint-cli2`,
  `gitleaks`). On a fresh machine: `curl https://mise.run | sh && mise install`
  from the repo root.

## Bootstrap

```sh
# (host) Build the dev image, install deps, register lefthook hooks:
just bootstrap
```

This runs inside the dev container:

- `pnpm install --recursive --frozen-lockfile`
- `pnpm -r run codegen` (paraglide + drizzle codecs)
- `lefthook install`

## The inner loop

```sh
# Apply D1 migrations to the local fixture database:
just migrate-local

# Start the dev stack (OTel collector + Jaeger + wrangler dev):
just dev-up
```

After `just dev-up`:

- `http://localhost:8787/api/v1/queue` — the public projection feed
- `http://localhost:8787/api/v1/queue/events` — SSE projection stream
- `http://localhost:16686` — Jaeger UI (search for
  `usecase.IssueTicket` after a queue mutation)
- `http://localhost:5173` — SvelteKit frontend (`apps/web`), if you
  also ran `just dev-web` (separate terminal)

Drive an end-to-end queue flow from the host:

```sh
# Issue → CallNext → MarkServed curl chain:
just smoke-queue
```

Then poke at the cron-driven side:

```sh
just trigger-scheduled
# Produces a `usecase.PurgeStalePii` span with
# usecase.invocation.kind="scheduled".
```

Tail structured logs through `jq` for trace correlation:

```sh
just log-tail | jq 'select(.traceId)'
```

## The pre-push gate

Run before every `git push`:

```sh
just check
```

This is the lefthook pre-push mirror — typecheck, biome, eslint,
markdownlint, depcruise, vitest (apps/default + apps/web +
packages/core), coverage, knip, type-coverage, comment-bans, schema
drift, error-doc drift. Each gate fails fast and tells you what to
fix.

If error-doc drift fires, `just gen-error-docs` regenerates and you
commit `docs/error-codes.md`.

Mutation testing and the bench baseline are *not* in `just check` —
they're heavy and on-demand:

```sh
just mutation        # Stryker, takes ~10 minutes
just bench           # vitest --bench (replay / projection / transitions)
```

## Where things live

```text
packages/core/             pure domain + application ports + use cases
  src/domain/              entities, value objects, errors, events
  src/application/
    ports/                 Context.Service tags
    runtime/               Telemetry, BackoffPolicy
    usecases/              IssueTicket, CallNext, MarkServed, …
  src/infrastructure/      Live layers (Clock, IdGenerator, repo, observability)

apps/default/              Cloudflare Worker — the only Effect.runPromise site
  src/worker.ts            instrument(...) wrap + cron handler + scheduled trigger
  src/server/http/         Hono router + Match.tagged error envelope + CORS / security headers
  src/server/adapters/     D1, Workers Logger, RuntimeMode adapters
  src/server/durableObjects/  QueueShop DO (single-writer, event-sourced)
  src/server/schema/       drizzle schemas: ticket_events, aggregate_snapshots, tickets, outbox

apps/web/                  SvelteKit 2 frontend (Cloudflare Pages target)
  src/routes/              customer / staff routes
  src/lib/api.ts           REST + SSE client for the worker
  messages/                paraglide-js i18n catalogues

docs/
  adr/                     Architecture Decision Records (MADR 4.0)
  observability.md         the OTel + log + audit triple
  operator/runbook.md      incident triage
  error-codes.md           generated tag table (drift-gated)
```

## Common edits, ordered

1. Add a domain error class →
   `packages/core/src/domain/errors/Errors.ts` (registry-driven).
2. Add the corresponding arm in
   `apps/default/src/server/http/errorEnvelope.ts`'s
   `Match.tagged` (the exhaustive match flips a future error class
   into a compile error until the HTTP status is assigned).
3. Run `just gen-error-docs` and commit the regenerated
   `docs/error-codes.md` + the i18n key in
   `apps/web/messages/{ja,en}.json`.
4. Add a use case →
   `packages/core/src/application/usecases/queue/<Verb>.ts` plus a
   test under `packages/core/test/application/usecases/queue/`.
5. Wire it through the Hono router →
   `apps/default/src/server/http/router.ts`.
6. Run `just check`. Fix any drift it reports.

## When something is unclear

- The runbook ([docs/operator/runbook.md](./operator/runbook.md)) covers
  the operational failure modes the deployed queue exposes.
- The observability primer ([docs/observability.md](./observability.md))
  walks through trace / log / audit correlation step by step.
- The contributor guide ([CONTRIBUTING.md](../CONTRIBUTING.md)) covers
  the commit / ADR / lefthook workflow.
- The ADR index ([docs/ADR_INDEX.md](./ADR_INDEX.md)) is the table of
  contents for every architectural decision; controversial calls are
  in the related ADR.
