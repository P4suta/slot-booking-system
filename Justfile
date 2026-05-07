set shell := ["bash", "-eu", "-o", "pipefail", "-c"]
set dotenv-load := false

# ---------------------------------------------------------------------------
# Every recipe runs inside the lean Node 22 dev container (ADR-0015).
# Host installs only `just`, `lefthook`, `committed`, `typos`, `actionlint`,
# `markdownlint-cli2` (managed by mise). Node / pnpm / wrangler / biome /
# vitest live exclusively inside `docker compose dev`.
# ---------------------------------------------------------------------------

DEV  := "docker compose run --rm dev"
DEVP := "docker compose run --rm --service-ports dev"   # publishes ports
CI   := "docker compose run --rm ci"

# Common in-container CLIs through pnpm / corepack so they pin the workspace's
# installed version. Direct `./node_modules/.bin/<x>` is also fine; we prefer
# the pnpm form for consistency.
PNPM := "corepack pnpm"

default:
    @just --list --unsorted

# ---------------------------------------------------------------------------
# Bootstrap
# ---------------------------------------------------------------------------

# Build the dev image, install workspace deps, compile generated
# code (paraglide messages, gql.tada introspection), register git
# hooks.
bootstrap: image install codegen hooks

image:
    docker compose build dev

install:
    {{DEV}} {{PNPM}} install --frozen-lockfile=false

# Compile inlang paraglide message catalogues into typed ESM modules
# under `apps/web/src/paraglide/`. The directory is git-ignored —
# the source of truth is `apps/web/messages/{ja,en}.json` plus the
# `project.inlang/` settings; compile turns those into the typed
# message functions consumed by `apps/web/src/lib/i18n.ts`.
paraglide:
    {{DEV}} bash -c "cd apps/web && {{PNPM}} run paraglide"

# Print the apps/default Pothos GraphQL schema to SDL
# (`apps/default/schema.graphql`) — the source of truth gql.tada
# walks against to type the apps/web query catalogue.
print-schema:
    {{DEV}} bash -c "cd apps/default && {{PNPM}} run print-schema"

# Regenerate apps/web's gql.tada introspection from the freshly
# printed SDL. Chains print-schema (server-side schema export) and
# graphql-env (client-side type emission).
graphql-env: print-schema
    {{DEV}} bash -c "cd apps/web && {{PNPM}} run graphql-env"

# Aggregate codegen for apps/web — paraglide messages plus the
# gql.tada schema introspection. Bootstrap and CI invoke this so
# typecheck has every generated artefact in place.
codegen: paraglide graphql-env

hooks:
    {{DEV}} lefthook install

hooks-uninstall:
    {{DEV}} lefthook uninstall

# Drop into an interactive shell inside the dev container.
sh:
    {{DEV}} bash

# ---------------------------------------------------------------------------
# Format / lint
# ---------------------------------------------------------------------------

fmt:
    {{DEV}} ./node_modules/.bin/biome format --write .

fmt-check:
    {{DEV}} ./node_modules/.bin/biome format .

# `--error-on-warnings` keeps the gate strict: Biome rules tagged as
# `warn` fail the run alongside `error`-level diagnostics.
lint-biome:
    {{DEV}} ./node_modules/.bin/biome check --error-on-warnings .

lint-biome-fix:
    {{DEV}} ./node_modules/.bin/biome check --write .

# Type-aware lints — typescript-eslint strict-type-checked +
# stylistic-type-checked presets. Catches bugs Biome's structural
# linter cannot (no-floating-promises, switch-exhaustiveness-check,
# no-misused-promises, no-unsafe-*). `--max-warnings=0` makes the
# gate strict — any rule emitting a warning fails the run.
lint-eslint:
    {{DEV}} ./node_modules/.bin/eslint . --max-warnings 0

lint-eslint-fix:
    {{DEV}} ./node_modules/.bin/eslint . --fix

markdownlint:
    markdownlint-cli2 \
        "**/*.md" \
        "#**/node_modules/**" \
        "#**/dist/**" \
        "#**/coverage/**" \
        "#**/PULL_REQUEST_TEMPLATE.md" \
        "#**/ISSUE_TEMPLATE/**" \
        "#apps/web/src/paraglide/**" \
        "#apps/web/project.inlang/**" \
        "#apps/web/src/graphql-env.d.ts"

lint: lint-biome lint-eslint markdownlint

# ---------------------------------------------------------------------------
# Type / arch / strict-code / dead-code gates
# ---------------------------------------------------------------------------

typecheck:
    {{DEV}} ./node_modules/.bin/tsc -b --pretty

# Architecture: dependency-cruiser enforces layer direction + forbidden
# constructs (cloudflare:, … inside packages/core).
arch:
    {{DEV}} ./node_modules/.bin/depcruise --validate .dependency-cruiser.cjs packages/core/src apps

# Dead-code / unused-export detection. `--treat-config-hints-as-errors`
# turns knip's "you could narrow this config" hints into hard failures
# — quiet drift in `knip.json` is what they exist to prevent.
dead-code:
    {{DEV}} ./node_modules/.bin/knip --treat-config-hints-as-errors

# Type-coverage: percentage of expressions whose types are precisely
# known (not `any`). Threshold lives in `packages/core/package.json`'s
# `typeCoverage` block; default 99.5 %.
type-coverage:
    {{DEV}} {{PNPM}} -F @booking/core run type-coverage

# arethetypeswrong: validates the published package's `exports` map
# resolves correctly across Node 16+, ESM, and bundler conditions.
attw:
    {{DEV}} {{PNPM}} -F @booking/core run build
    {{DEV}} {{PNPM}} -F @booking/core run attw

# size-limit gate for @booking/core — enforces a gzip ceiling on the
# library bundle so additions do not silently bloat downstream apps.
# Threshold lives in `packages/core/package.json#size-limit`.
size-limit-core:
    {{DEV}} {{PNPM}} -F @booking/core run build
    {{DEV}} {{PNPM}} -F @booking/core run size-limit

# PII guard: forbids field/column declarations and URL/email-host literals
# tied to PII, throughout source. See ADR-0009.
pii-guard:
    {{DEV}} bash -c '! rg -n --type-add "svelte:*.svelte" -t ts -t svelte -t sql -e "(\b(email|phone_number|address|birthday|gender)\s*[:=]|mailto:|@gmail\.|@yahoo\.)" packages apps -g "!**/CHANGELOG*"'

# Domain-purity: forbid industry-specific terms inside packages/core +
# apps/default.
domain-purity:
    {{DEV}} bash -c '! rg -n -i -e "\b(bike|bicycle|repair|mechanic|dental|hair|barber|stylist|salon|massage|patient|cycle\s*shop)\b" packages apps -g "!**/docs/adr/**"'

# Forbidden constructs grep: Date, throw, @ts-ignore (ADR-0010).
# Scope is `packages/core/src` only — the DO actor-model code in
# `apps/default/src/server/durableObjects/` runs outside the Effect
# runtime (Cloudflare DO `setAlarm` and outbox `recordedAt` need
# raw `Date.now()` / `new Date().toISOString()`), so the rule applies
# to the functional core, not the imperative shell.
strict-code:
    {{DEV}} bash -c '! rg -n -t ts -e "\bnew Date\(|\bDate\.now\(|@ts-ignore|@ts-expect-error|: any\b" packages/core/src 2>/dev/null'

# ---------------------------------------------------------------------------
# Test
# ---------------------------------------------------------------------------

test:
    {{DEV}} {{PNPM}} -r run test

test-watch:
    {{DEV}} {{PNPM}} -r run test:watch

test-coverage:
    {{DEV}} {{PNPM}} -r run test:coverage

test-property:
    {{DEV}} {{PNPM}} -F @booking/core run test:property

# Performance baseline. Vitest's `bench` runner (experimental).
bench:
    {{DEV}} {{PNPM}} -F @booking/core run test:bench

# Mutation testing (Stryker). Heavy; run on demand, not in pre-push.
mutation:
    {{DEV}} {{PNPM}} -F @booking/core run test:mutation

# ---------------------------------------------------------------------------
# Build / pack
# ---------------------------------------------------------------------------

build:
    {{DEV}} {{PNPM}} -r run build

# Pack the core package and verify it loads from a tarball — sanity for
# future cross-repo distribution (ADR-0011).
pack-core:
    {{DEV}} {{PNPM}} -F @booking/core run build
    {{DEV}} {{PNPM}} -F @booking/core pack --pack-destination /tmp

# ---------------------------------------------------------------------------
# Cloudflare local dev (apps/default)
# ---------------------------------------------------------------------------

dev-default:
    {{DEVP}} {{PNPM}} -F default run dev

migrate-local:
    {{DEV}} {{PNPM}} -F default exec wrangler d1 migrations apply DB --local

# Smoke-check `availableSlots` against a running `just dev-default`.
# Preconditions (documented in the script): migrations applied + seed
# loaded + wrangler dev up on :8787. Override host with
# `SMOKE_GRAPHQL_ENDPOINT=http://...`. The recipe runs on the host
# (not in the dev container) so it can reach the dev process.
smoke-available-slots:
    bash apps/default/scripts/smoke-available-slots.sh

# End-to-end smoke for the customer flow:
# `availableSlots` → `holdSlot`. Same preconditions as above.
# The Miniflare integration suite (`just test-integration`) is the
# in-process counterpart; this recipe is the host-level signal that
# every layer (resolver, token verify, DO RPC, SQL, outbox, audit)
# is wired up against `wrangler dev --local`.
smoke-booking-flow:
    bash apps/default/scripts/smoke-booking-flow.sh

# Apply the catalog seed to the local D1. Idempotent — re-running
# refreshes the rows. Generates the SQL document on the fly via
# `apps/default/seed/seed.ts`, so the seed is always in lockstep
# with the catalog Schemas (no hand-written SQL to drift).
seed:
    {{DEV}} bash -c '\
      cd apps/default && \
      {{PNPM}} exec tsx seed/seed.ts > .seed.generated.sql && \
      {{PNPM}} exec wrangler d1 execute DB --local --file=.seed.generated.sql && \
      rm -f .seed.generated.sql'

# ---------------------------------------------------------------------------
# Observability stack (Phase 3 PR#8)
# ---------------------------------------------------------------------------

# Bring up the full local-dev stack: OTel collector + Jaeger UI under
# the `observability` docker-compose profile (`docker-compose.yml`),
# then `wrangler dev -e dev` in the foreground. Exit Ctrl-C closes
# wrangler; collector + jaeger keep running until `just dev-down`.
# The dev env wires `OTEL_EXPORTER_URL = http://otel-collector:4318/v1/traces`,
# so usecase / graphql spans land in Jaeger at http://localhost:16686.
dev-up:
    docker compose --profile observability up -d otel-collector jaeger
    {{DEVP}} {{PNPM}} -F default run dev

# Tear down the observability profile services brought up by `dev-up`.
dev-down:
    docker compose --profile observability down

# Manually trigger the `scheduled()` handler on a running
# `dev-default` / `dev-up`. Wrangler dev exposes the cron entrypoint
# at `/__scheduled` when `compatibility_date` is recent enough; the
# call wakes `PurgeStalePii()` so the operator can verify the path
# without waiting for a real cron firing.
trigger-scheduled:
    curl -fsS -X POST http://localhost:8787/__scheduled -H "content-type: application/json" -d '{}' || \
      echo "trigger-scheduled: ensure 'just dev-up' (or 'just dev-default') is running"

# Run an arbitrary SQL statement against the local D1 fixture.
# Usage: `just d1-shell SQL='SELECT count(*) FROM services'`
d1-shell SQL:
    {{DEV}} {{PNPM}} -F default exec wrangler d1 execute DB --local --command="{{SQL}}"

# Tail the structured-log stream from a running `wrangler dev`. The
# pipe filters JSON lines that look like `LogPayload` records (i.e.
# carry a `code` field) and drops the wrangler banner / OTLP noise,
# so `just log-tail` is what an operator follows during a smoke run.
log-tail:
    docker compose logs -f --no-log-prefix dev 2>/dev/null | jq -Rc 'fromjson? | select(.code != null)'

# Apply migrations + seed + run both smoke scripts in sequence. Stops
# at the first failure (set -e); each step prints its own status so
# the failure mode is immediately visible. Pre-condition: a running
# `just dev-up` (or `just dev-default`).
smoke-all:
    just migrate-local
    just seed
    just smoke-available-slots
    just smoke-booking-flow

# ---------------------------------------------------------------------------
# Aggregate gates
# ---------------------------------------------------------------------------

# Pre-push mirror: every check the lefthook pre-push hook runs,
# plus markdownlint (host-side, not in lefthook because the host
# binary is mise-managed and faster to invoke directly), plus the
# core library size-limit gate. Skip mutation testing (heavy) and
# bench (informational).
check: lint typecheck arch pii-guard domain-purity strict-code dead-code type-coverage test-coverage size-limit-core

# Full CI gate: check + build (and the apps/default dev smoke happens
# externally on demand via `just dev-default`).
ci: check build
