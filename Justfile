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
# code (paraglide messages), register git hooks.
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

codegen: paraglide

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
        "#apps/web/project.inlang/**"

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

# Comment-bans: reject historical narrative tokens (queue-pivot
# milestone names, scrapped framework names) outside the ADR archive
# / CHANGELOG. Source describes the present; git log + ADRs own the
# milestone trail.
comment-bans:
    {{DEV}} bash scripts/lint/comment-bans.sh

# Forbidden constructs grep: Date, throw, @ts-ignore (ADR-0010).
# Scope is `packages/core/src` only — the DO actor-model code in
# `apps/default/src/server/durableObjects/` runs outside the Effect
# runtime (Cloudflare DO `setAlarm` and outbox `recordedAt` need
# raw `Date.now()` / `new Date().toISOString()`), so the rule applies
# to the functional core, not the imperative shell.
strict-code:
    # packages/core/src は宣言的・Effect-only zone。 raw Date / @ts-* /
    # : any 注釈を grep 禁止 (domain layer の総合品質担保)。
    {{DEV}} bash -c '! rg -n -t ts -e "\bnew Date\(|\bDate\.now\(|@ts-ignore|@ts-expect-error|: any\b" packages/core/src 2>/dev/null'
    # 全 workspace で `as any` / `<any>` cast を禁止。 ESLint の
    # strict-type-checked が宣言的な `any` は既に弾くが、 cast は
    # path によって checker の盲点になるので grep gate で補完する。
    # `as unknown as X` は別 recipe で集計のみ (legitimate な upstream
    # API workaround の判別が機械的にできないため hard gate しない、
    # 'just diagnose-tsescapes' で件数を可視化して PR で議論)。
    {{DEV}} bash -c '! rg -n --type-add "svelte:*.svelte" -t ts -t svelte -e "\bas any\b|<any>(?![A-Za-z])" packages apps 2>/dev/null'

# 'as unknown as X' の使用箇所一覧。 hard gate ではなく diagnostic。
# 件数が増えたら memory feedback_root_cause_over_unknown_cast に従って
# Schema.Top vs Codec vs Decoder 等の型構造ミスマッチを root-cause fix。
diagnose-tsescapes:
    @echo "=== 'as unknown as' usage (root-cause fix candidates) ==="
    @{{DEV}} bash -c 'rg -n --type-add "svelte:*.svelte" -t ts -t svelte "as unknown as" packages apps 2>/dev/null' || true
    @echo
    @echo "=== count by file (top 10) ==="
    @{{DEV}} bash -c 'rg -l --type-add "svelte:*.svelte" -t ts -t svelte "as unknown as" packages apps 2>/dev/null | xargs -I{} sh -c "rg -c \"as unknown as\" {} | sed \"s|^|{}: |\"" | sort -t: -k2 -rn | head -10' || true

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

# apps/web の Vite dev server (port 5173)。 docker-compose.yml の
# `dev-web` service で port を分離してあるので、 `just dev-default`
# (8787) と並走できる。 ブラウザは http://localhost:5173 で開く。
dev-web:
    docker compose run --rm --service-ports dev-web {{PNPM}} -F web run dev -- --host 0.0.0.0

migrate-local:
    {{DEV}} {{PNPM}} -F default exec wrangler d1 migrations apply DB --local

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
# Observability stack
# ---------------------------------------------------------------------------

# Bring up the full local-dev stack: OTel collector + Jaeger UI under
# the `observability` docker-compose profile (`docker-compose.yml`),
# then `wrangler dev` in the foreground with the OTLP endpoint pinned
# to the collector container. Exit Ctrl-C closes wrangler; collector
# + jaeger keep running until `just dev-down`. usecase / queue / DO
# spans land in Jaeger at http://localhost:16686.
dev-up:
    docker compose --profile observability up -d otel-collector jaeger
    {{DEVP}} {{PNPM}} -F default exec wrangler dev --ip 0.0.0.0 --test-scheduled \
      --var IS_DEV:1 --var OTEL_EXPORTER_URL:http://otel-collector:4318/v1/traces

# Tear down the observability profile services brought up by `dev-up`.
dev-down:
    docker compose --profile observability down

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

# Regenerate `docs/error-codes.md` from `errorClassRegistry`. Drift
# gate runs as part of `just check`; editing this file by hand fails.
gen-error-docs:
    {{DEV}} bash -c "cd apps/default && corepack pnpm exec tsx scripts/gen-error-docs.ts" > docs/error-codes.md

# ---------------------------------------------------------------------------
# Diagnose — multi-gate snapshot (continue-on-fail, never gate)
# ---------------------------------------------------------------------------

# Run every quality gate `just check` would, but with `set +e` so a
# failing gate does not short-circuit the rest. Markdown summary lands
# in `.diagnose/last-run.md` and stdout. Phase A wraps `typecheck`
# only; Phase B/C extend with biome / eslint / arch / test JSON
# aggregation. Exit code is **always 0** — diagnose is a snapshot,
# not a gate. Use `just check` for the fail-fast normative gate.
diagnose:
    bash scripts/diagnose.sh

# Typecheck deep-dive — file 別 top 10 + error code 別 top 10 + (file ×
# error code) pair top 10. Standalone; same data also fed into
# `just diagnose` summary.
diagnose-tsc:
    bash scripts/diagnose-tsc.sh

# Biome deep-dive — file 別 + rule 別の violation 集計。
diagnose-biome:
    bash scripts/diagnose-biome.sh

# ESLint deep-dive — file 別 + rule 別の message 集計。
diagnose-eslint:
    bash scripts/diagnose-eslint.sh

# dependency-cruiser deep-dive — rule 別 + source 別の violation 集計。
diagnose-arch:
    bash scripts/diagnose-arch.sh

# Vitest deep-dive — workspace 別 failed test 集計。
diagnose-test:
    bash scripts/diagnose-test.sh

# Guards (PII / domain-purity / strict-code / dead-code / type-coverage /
# error-docs-drift) を順次回し、 各 pass/fail を集計。
diagnose-guards:
    bash scripts/diagnose-guards.sh

# Fast feedback: pre-commit gate のみ (typos + biome staged) を回す軽量
# lane。 < 5 秒。 修正サイクルの中で「format / typo は通った?」 を quick check
# する用途。
diagnose-fast:
    {{DEV}} bash -c '! rg -n --type-add "svelte:*.svelte" -e "(\b(email|phone_number|address|birthday|gender)\s*[:=]|mailto:|@gmail\.|@yahoo\.)" packages apps -g "!**/CHANGELOG*"'
    {{DEV}} ./node_modules/.bin/biome check --error-on-warnings .

# Watch mode: tsc -w + vitest --watch + biome check --watch を docker
# compose run で並走。 'just watch' で起動、 Ctrl-C で全停止。
# Cloudflare Workers の watch は wrangler dev 自身が watch なので
# 別経路 (just dev-default) で。
watch:
    {{DEV}} bash -c '\
      ./node_modules/.bin/tsc -b --watch --preserveWatchOutput & \
      cd packages/core && ./node_modules/.bin/vitest --watch & \
      wait'

# 'docs/error-codes.md' を強制再生成 (errorClassRegistry が変わった後)。
# error-docs-drift-check が落ちる場合の baseline 復活用。
error-docs-refresh:
    just gen-error-docs

# ---------------------------------------------------------------------------
# Aggregate gates
# ---------------------------------------------------------------------------

# Pre-push mirror: every check the lefthook pre-push hook runs,
# plus markdownlint (host-side, not in lefthook because the host
# binary is mise-managed and faster to invoke directly), plus the
# core library size-limit gate. Skip mutation testing (heavy) and
# bench (informational).
check: lint typecheck arch pii-guard domain-purity comment-bans strict-code dead-code type-coverage test-coverage size-limit-core error-docs-drift-check

# Drift gate for `docs/error-codes.md`. Re-runs `gen-error-docs`
# and fails if the working tree disagrees — adding a new error
# class to `errorClassRegistry` (or renaming one) without
# refreshing the docs is rejected.
error-docs-drift-check:
    just gen-error-docs
    git diff --exit-code -- docs/error-codes.md

# Full CI gate: check + build (and the apps/default dev smoke happens
# externally on demand via `just dev-default`).
ci: check build
