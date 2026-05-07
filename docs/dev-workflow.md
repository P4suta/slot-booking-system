# Developer workflow

Fresh-clone walkthrough — what to install, what to run, and what to
expect at each step. Every command runs inside the Docker dev
container (ADR-0015) except where explicitly marked **(host)**.

## Prerequisites

On the host:

- Docker (Docker Desktop on macOS / Windows, native Docker on Linux).
- `mise` — pins the host-side toolchain (`just`, `lefthook`,
  `committed`, `typos`, `actionlint`, `markdownlint-cli2`). On a
  fresh machine: `curl https://mise.run | sh && mise install` from
  the repo root.

## Bootstrap

```sh
# (host) Build the dev image, install deps, register lefthook hooks:
just bootstrap
```

This runs inside the dev container:

- `pnpm install --recursive --frozen-lockfile`
- `pnpm -r run codegen` (paraglide + gql.tada + drizzle codecs)
- `lefthook install`

## The inner loop

```sh
# Apply D1 migrations to the local fixture database:
just migrate-local

# Seed the catalog with the demo entities (services, providers, …):
just seed

# Start the dev stack (OTel collector + Jaeger + wrangler dev):
just dev-up
```

After `just dev-up`:

- `http://localhost:8787/graphql` — the GraphQL endpoint
- `http://localhost:16686` — Jaeger UI (search for `usecase.HoldSlot`
  after a booking)
- `http://localhost:5173` — SvelteKit frontend (`apps/web`), if you
  also ran `just dev-web` (separate terminal)

Drive an end-to-end booking flow from the host:

```sh
# In a second terminal, run the smoke battery:
just smoke-all
```

Each smoke step:

1. `just smoke-available-slots` — `availableSlots` query against the
   seeded fixture. Returns ≥ 1 slot for the seeded business hours.
2. `just smoke-booking-flow` — `holdSlot` → confirms the booking
   reaches `Held` state. Returns a typed
   `MutationHoldSlotSuccess`.

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
packages/core), coverage, knip, type-coverage, size-limit, schema
drift, error-doc drift. Each gate fails fast and tells you what
to fix.

If schema drift fires (`just schema-drift-check`), you most likely
edited a domain `Schema` declaration without re-printing — the
fix is `just gen-error-docs` (yes — schema and error docs are sister
generators) plus committing the regenerated
`apps/default/schema.graphql` byte-equal output.

If error-doc drift fires, `just gen-error-docs` regenerates and you
commit `docs/error-codes.md`.

Mutation testing and the bench baseline are *not* in `just check` —
they're heavy and on-demand:

```sh
just mutation        # Stryker, takes ~10 minutes
just bench           # vitest --bench against the slot computer
```

## Where things live

```text
packages/core/             pure domain + application ports + use cases
  src/domain/              entities, value objects, errors, events
  src/application/
    ports/                 Context.Service tags
    runtime/               Telemetry, BackoffPolicy
    usecases/              HoldSlot, ConfirmBooking, …
  src/infrastructure/      Live layers (Clock, IdGenerator, repo, observability)

apps/default/              Cloudflare Worker — the only Effect.runPromise site
  src/worker.ts            instrument(...) wrap + cron handler + scheduled trigger
  src/server/graphql/      Schema-derived schema + resolvers + plugins
  src/server/adapters/     D1, Workers Logger, RuntimeMode adapters
  src/server/durableObjects/  DaySchedule DO + effectRpc transport

apps/web/                  SvelteKit 2 frontend (Cloudflare Pages target)
  src/routes/              customer / staff routes
  src/lib/graphql/         gql.tada client + endpoint resolution
  messages/                paraglide-js i18n catalogues

docs/
  adr/                     Architecture Decision Records (MADR 4.0)
  observability.md         the OTel + log + audit triple
  api/graphql.md           consumer-facing GraphQL reference
  runbook.md               incident triage
  error-codes.md           generated tag table (drift-gated)
```

## Common edits, ordered

1. Add a domain error class →
   `packages/core/src/domain/errors/Errors.ts` (registry-driven).
2. Run `just gen-error-docs` and commit the regenerated
   `docs/error-codes.md` + the i18n key in `apps/web/messages/{ja,en}.json`.
3. Add a use case →
   `packages/core/src/application/usecases/<Verb>.ts` plus a test
   under `packages/core/test/application/usecases/`.
4. Wire it through GraphQL →
   `apps/default/src/server/graphql/resolvers/<area>.ts`.
5. Run `just check`. Fix any drift it reports.

## When something is unclear

- The runbook ([docs/runbook.md](./runbook.md)) covers the operational
  failure modes the deployed system exposes.
- The observability primer ([docs/observability.md](./observability.md))
  walks through trace / log / audit correlation step by step.
- The contributor guide ([CONTRIBUTING.md](../CONTRIBUTING.md)) covers
  the commit / ADR / lefthook workflow.
- The ADR index ([docs/ADR_INDEX.md](./ADR_INDEX.md)) is the table of
  contents for every architectural decision; controversial calls are
  in the related ADR.
