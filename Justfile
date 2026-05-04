set shell := ["bash", "-eu", "-o", "pipefail", "-c"]
set dotenv-load := false

# Every recipe runs inside the lean Node 22 dev container. The host
# never invokes node / pnpm / wrangler directly.
DEV  := "docker compose run --rm dev"
DEVP := "docker compose run --rm --service-ports dev"   # publishes ports
CI   := "docker compose run --rm ci"

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
    {{DEV}} corepack pnpm install --frozen-lockfile=false

hooks:
    {{DEV}} lefthook install

hooks-uninstall:
    {{DEV}} lefthook uninstall

# Drop into an interactive shell inside the dev container.
sh:
    {{DEV}} bash

# ---------------------------------------------------------------------------
# Lint / format
# ---------------------------------------------------------------------------

fmt:
    {{DEV}} corepack pnpm -w exec biome format --write .

fmt-check:
    {{DEV}} corepack pnpm -w exec biome format .

lint-biome:
    {{DEV}} corepack pnpm -w exec biome check .

typos:
    {{DEV}} corepack pnpm -w exec typos -- || {{DEV}} sh -c 'command -v typos || true'

actionlint:
    {{DEV}} corepack pnpm -w exec actionlint -- || true

markdownlint:
    {{DEV}} corepack pnpm -w exec markdownlint-cli2 \
        "**/*.md" \
        "#node_modules" \
        "#dist" \
        "#coverage" \
        "#**/PULL_REQUEST_TEMPLATE.md" \
        "#**/ISSUE_TEMPLATE/**"

lint: fmt-check lint-biome markdownlint

# ---------------------------------------------------------------------------
# Type / arch / guard gates
# ---------------------------------------------------------------------------

typecheck:
    {{DEV}} corepack pnpm -r exec tsc --noEmit

# Architecture: dependency-cruiser enforces layer direction + forbidden
# constructs (Date, throw, cloudflare:, …) inside packages/core.
arch:
    {{DEV}} corepack pnpm -w exec depcruise -- --config .dependency-cruiser.cjs packages apps

# PII-guard: forbid PII intent in source. Matches field/column declarations
# and URL/email-host literals — not prose mentions of the words.
pii-guard:
    {{DEV}} bash -c '! rg -n --type-add "svelte:*.svelte" -t ts -t svelte -t sql -e "(\\b(email|phone_number|address|birthday|gender)\\s*[:=]|mailto:|@gmail\\.|@yahoo\\.)" packages apps -g "!**/CHANGELOG*"'

# Domain-purity: forbid industry-specific vocabulary inside core + default app.
domain-purity:
    {{DEV}} bash -c '! rg -n -i -e "\\b(bike|bicycle|repair|mechanic|dental|hair|barber|stylist|salon|massage|patient|cycle\\s*shop)\\b" packages apps -g "!**/docs/adr/**" -g "!Justfile"'

# Forbidden constructs: Date / throw / @ts-ignore inside src trees.
strict-code:
    {{DEV}} bash -c '! rg -n -t ts -e "\\bnew Date\\(|\\bDate\\.now\\(|@ts-ignore|@ts-expect-error|: any\\b" packages/core/src apps/default/src 2>/dev/null'

# ---------------------------------------------------------------------------
# Test / coverage
# ---------------------------------------------------------------------------

test:
    {{DEV}} corepack pnpm -r run test

test-watch:
    {{DEV}} corepack pnpm -r run test:watch

test-coverage:
    {{DEV}} corepack pnpm -r run test:coverage

test-property:
    {{DEV}} corepack pnpm -F @booking/core run test:property

# ---------------------------------------------------------------------------
# Build / pack
# ---------------------------------------------------------------------------

build:
    {{DEV}} corepack pnpm -r run build

pack-core:
    {{DEV}} corepack pnpm -F @booking/core run build
    {{DEV}} corepack pnpm -F @booking/core pack --pack-destination /tmp

# ---------------------------------------------------------------------------
# Cloudflare local dev (apps/default)
# ---------------------------------------------------------------------------

dev-default:
    {{DEVP}} corepack pnpm -F default run dev

migrate-local:
    {{DEV}} corepack pnpm -F default exec wrangler d1 migrations apply DB --local

# ---------------------------------------------------------------------------
# Aggregate
# ---------------------------------------------------------------------------

check: lint typecheck arch pii-guard domain-purity strict-code test-coverage

ci: check build
