# Contributing to slot-booking-system

Thank you for considering a contribution. The architecture decisions
this guide implements live in
[`docs/ADR_INDEX.md`](./docs/ADR_INDEX.md); the per-task walkthrough
is [`docs/dev-workflow.md`](./docs/dev-workflow.md).

## TL;DR

1. Open an issue or grab one from the tracker.
2. Branch off `main`. Use a descriptive slug
   (`feat/recall-undo`, `fix/no-show-sweep-window`).
3. Run `just bootstrap` once. Run `just check` before every push.
4. Land changes through pull requests. Squash-merge. Conventional
   Commits — see "Commit style" below.

## Architecture invariants

Two invariants gate every commit:

1. **Functional Core / Imperative Shell** (ADR-0018) —
   `packages/core` is pure (`Effect`-laden, no side effects in the
   source). Side effects live in adapter Live layers under
   `infrastructure/` or `apps/<deployment>/src/server/adapters/`.
   Enforced by `dependency-cruiser`.
2. **Schema is the source of truth** (ADR-0036) — every wire shape
   is decoded through `Effect.Schema` at the boundary; the queue's
   REST + SSE / WebSocket surface emits its OpenAPI 3.1 spec from
   the same Schema declarations the use cases consume.

PII discipline (ADR-0009) and the absence of industry-specific
vocabulary in the queue core remain project rules; they are
enforced by code review rather than a static grep gate.

If your change touches a layering boundary, an ADR is required (see
"Authoring an ADR" below).

## Day-1 discipline

- **TDD** — failing test first. Vitest + property tests via
  fast-check. The test file lives next to the source under
  `packages/core/test/` (or `apps/default/test/` for adapter-tier
  surfaces). C1 100 % branch coverage is the standing target.
- **Branch coverage matters** — V8 line coverage hides the
  conditional inversions that branch coverage catches. Use
  property-based tests when the logic is non-trivial (e.g.,
  `BackoffPolicy.test.ts`, `transitions.test.ts`).
- **Public docs follow the code** — adding a new
  `Schema.TaggedError` triggers `just gen-error-docs` (regenerates
  `docs/error-codes.md`) and an i18n catalogue update
  (`apps/web/messages/{ja,en}.json`). The drift gate fires if you
  forget.

## Lefthook gates (what runs on `git commit` / `git push`)

The full configuration is `lefthook.yml`. Pre-commit hooks (run on
the staged subset for speed):

- `typos` — spelling on text content.
- `comment-bans-staged` — historical-narrative tokens (queue-pivot
  milestone names, scrapped framework names) are rejected; ADRs and
  CHANGELOG keep the trail.
- `biome-staged` — formatter + linter pass over staged files.
- `committed` — Conventional Commits structure on the message.

Pre-push hook runs the `just check` mirror — typecheck, biome,
eslint, markdownlint, depcruise, vitest, coverage, knip,
type-coverage, error-doc drift, comment-bans.

## Commit style

Conventional Commits, capitalised subject (the `committed` hook
enforces both):

```text
feat: Recall a mistakenly-called ticket

Recall reverses an accidental CallNext: Called -> Waiting with the
original `seq` preserved so the customer returns to the head of the
queue. The audit log retains both the original `Called` and the new
`Recalled` events.

Test plan:
- packages/core/test/domain/queue/transitions.test.ts (Recall arm)
- packages/core/test/application/usecases/queue/Lifecycle.test.ts
EOF
```

- Type prefixes: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`,
  `build`, `ci`. Subject ≤ 50 chars (lefthook limit).
- The body is wrapped at 72 chars and is the primary surface for
  *why* — code already shows *what*. The "Test plan" footer is a
  promise to operators that the change is testable end-to-end.
- One topic per commit. ADR references (`ADR-NNNN`) belong in the
  body or in the source as inline comments where they are
  load-bearing.

## Authoring an ADR

1. Copy `docs/adr/0000-template.md` to
   `docs/adr/NNNN-short-slug.md` with the next sequential number.
2. Fill the sections; keep paragraphs short and action-oriented.
3. Status starts as `proposed` if controversial, `accepted` if the
   call is clear at landing time. Use `Superseded-By: ADR-NNNN` (and
   the inverse `Supersedes: ADR-MMMM` on the new one) to retire an
   older decision; the cross-link is checked by the
   `adrSupersession` test.
4. Add a row to `docs/ADR_INDEX.md`.
5. Open a PR. Treat the ADR as a normal PR review — comments on the
   document file body are how alternatives surface.

## Recipe pointers

| If you want to … | Run |
|---|---|
| Bring up the dev stack | `just dev-up` |
| Smoke the queue flow end-to-end | `just smoke-queue` (lands with the queue-pivot follow-up plan) |
| Trigger the cron handler | `just trigger-scheduled` |
| Verify the pre-push pipeline | `just check` |
| Regenerate the error-tag doc | `just gen-error-docs` |
| Tail structured logs with jq | `just log-tail` |
| Run mutation tests (heavy) | `just mutation` |

The full recipe list is in [`Justfile`](./Justfile); the developer
walkthrough is [`docs/dev-workflow.md`](./docs/dev-workflow.md).

## Pull requests

- Branch off `main`, push, open a PR.
- Squash-merge by default. The PR title becomes the squashed commit
  message — write it as a Conventional Commit subject.
- CI must be green; reviewer approval required. The pre-push
  lefthook gate is the local mirror, so a green local push is
  generally a green CI run.

## Project memory

- [docs/SYSTEM.md](./docs/SYSTEM.md) — the iron principles the
  project is built on.
- [docs/ADR_INDEX.md](./docs/ADR_INDEX.md) — every architectural
  decision since the project bootstrap.
- [docs/error-codes.md](./docs/error-codes.md) — drift-gated error
  tag table.
- [docs/observability.md](./docs/observability.md) — OTel + log +
  audit triple primer.
- [docs/operator/runbook.md](./docs/operator/runbook.md) —
  operational triage for the deployed system.

## License

Dual-licensed under Apache-2.0 OR MIT (the contributor's choice on
each contribution; the project repo distributes both). By opening a
PR you agree your contribution is dual-licensed under the same
terms.
