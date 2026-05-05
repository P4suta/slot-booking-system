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

# Build the dev image, install workspace deps, register git hooks.
bootstrap: image install hooks

image:
    docker compose build dev

install:
    {{DEV}} {{PNPM}} install --frozen-lockfile=false

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

lint-biome:
    {{DEV}} ./node_modules/.bin/biome check .

lint-biome-fix:
    {{DEV}} ./node_modules/.bin/biome check --write .

# Type-aware lints — typescript-eslint strict-type-checked +
# stylistic-type-checked presets. Catches bugs Biome's structural
# linter cannot (no-floating-promises, switch-exhaustiveness-check,
# no-misused-promises, no-unsafe-*).
lint-eslint:
    {{DEV}} ./node_modules/.bin/eslint .

lint-eslint-fix:
    {{DEV}} ./node_modules/.bin/eslint . --fix

markdownlint:
    markdownlint-cli2 \
        "**/*.md" \
        "#node_modules" \
        "#dist" \
        "#coverage" \
        "#**/PULL_REQUEST_TEMPLATE.md" \
        "#**/ISSUE_TEMPLATE/**"

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

# Dead-code / unused-export detection.
dead-code:
    {{DEV}} ./node_modules/.bin/knip

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

# PII guard: forbids field/column declarations and URL/email-host literals
# tied to PII, throughout source. See ADR-0009.
pii-guard:
    {{DEV}} bash -c '! rg -n --type-add "svelte:*.svelte" -t ts -t svelte -t sql -e "(\b(email|phone_number|address|birthday|gender)\s*[:=]|mailto:|@gmail\.|@yahoo\.)" packages apps -g "!**/CHANGELOG*"'

# Domain-purity: forbid industry-specific terms inside packages/core +
# apps/default.
domain-purity:
    {{DEV}} bash -c '! rg -n -i -e "\b(bike|bicycle|repair|mechanic|dental|hair|barber|stylist|salon|massage|patient|cycle\s*shop)\b" packages apps -g "!**/docs/adr/**"'

# Forbidden constructs grep: Date, throw, @ts-ignore (ADR-0010).
strict-code:
    {{DEV}} bash -c '! rg -n -t ts -e "\bnew Date\(|\bDate\.now\(|@ts-ignore|@ts-expect-error|: any\b" packages/core/src apps/default/src 2>/dev/null'

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

# ---------------------------------------------------------------------------
# Aggregate gates
# ---------------------------------------------------------------------------

# Pre-push mirror: every check the CI workflow runs, but skip mutation
# testing (heavy) and bench (informational).
check: lint typecheck arch pii-guard domain-purity strict-code dead-code type-coverage test-coverage

# Full CI gate: check + build (and the apps/default dev smoke happens
# externally on demand via `just dev-default`).
ci: check build
